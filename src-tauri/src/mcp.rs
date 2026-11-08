//! A small MCP client: streamable-HTTP transport plus the MCP OAuth flow
//! (protected-resource discovery → dynamic client registration → PKCE
//! authorization code in the browser → token with refresh). Any MCP server
//! that follows the spec works; connector adapters on the UI side decide
//! which tools to call.

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crate::logging;
use crate::storage::blocking;

const KEYCHAIN: &str = "app.earshot.desktop";
const PROTOCOL: &str = "2025-06-18";

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
struct Credentials {
    client_id: String,
    token_endpoint: String,
    access_token: String,
    refresh_token: Option<String>,
    /// Unix seconds.
    expires_at: Option<u64>,
    resource: String,
}

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn keychain(id: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYCHAIN, &format!("mcp:{id}")).map_err(|e| e.to_string())
}

fn load_creds(id: &str) -> Option<Credentials> {
    keychain(id).ok()?.get_password().ok().and_then(|s| serde_json::from_str(&s).ok())
}

fn save_creds(id: &str, creds: &Credentials) -> Result<(), String> {
    keychain(id)?.set_password(&serde_json::to_string(creds).map_err(|e| e.to_string())?).map_err(|e| e.to_string())
}

fn agent() -> ureq::Agent {
    ureq::AgentBuilder::new().timeout(Duration::from_secs(60)).build()
}

fn random_token(bytes: usize) -> String {
    let mut buf = vec![0u8; bytes];
    getrandom::getrandom(&mut buf).expect("system randomness");
    URL_SAFE_NO_PAD.encode(buf)
}

fn get_json(url: &str) -> Result<Value, String> {
    agent().get(url).call().map_err(|e| format!("{url}: {e}"))?.into_json().map_err(|e| e.to_string())
}

/// RFC 9728 → RFC 8414: find the authorization server for an MCP endpoint.
fn discover(server_url: &str) -> Result<(Value, String), String> {
    let u = url::Url::parse(server_url).map_err(|e| e.to_string())?;
    let origin = format!("{}://{}", u.scheme(), u.host_str().unwrap_or_default());
    let origin = match u.port() {
        Some(p) => format!("{origin}:{p}"),
        None => origin,
    };
    let path = u.path().trim_end_matches('/');
    let resource_meta = get_json(&format!("{origin}/.well-known/oauth-protected-resource{path}"))
        .or_else(|_| get_json(&format!("{origin}/.well-known/oauth-protected-resource")))?;
    let issuer = resource_meta["authorization_servers"][0].as_str().unwrap_or(&origin).trim_end_matches('/').to_string();
    let resource = resource_meta["resource"].as_str().unwrap_or(server_url).to_string();
    let meta = get_json(&format!("{issuer}/.well-known/oauth-authorization-server"))
        .or_else(|_| get_json(&format!("{issuer}/.well-known/openid-configuration")))?;
    Ok((meta, resource))
}

/// Waits for the browser to hit http://127.0.0.1:<port>/callback?code=…&state=…
fn wait_for_code(listener: TcpListener, state: &str) -> Result<String, String> {
    listener.set_nonblocking(false).map_err(|e| e.to_string())?;
    let deadline = SystemTime::now() + Duration::from_secs(300);
    loop {
        if SystemTime::now() > deadline {
            return Err("Sign-in timed out after 5 minutes".into());
        }
        let (mut stream, _) = listener.accept().map_err(|e| e.to_string())?;
        let mut line = String::new();
        BufReader::new(stream.try_clone().map_err(|e| e.to_string())?).read_line(&mut line).map_err(|e| e.to_string())?;
        let target = line.split_whitespace().nth(1).unwrap_or("/");
        let parsed = url::Url::parse(&format!("http://localhost{target}")).map_err(|e| e.to_string())?;
        let params: HashMap<String, String> = parsed.query_pairs().into_owned().collect();
        if parsed.path() != "/callback" {
            let _ = stream.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n");
            continue;
        }
        let (ok, body) = match (params.get("code"), params.get("state"), params.get("error")) {
            (Some(code), Some(s), _) if s == state => (Ok(code.clone()), "Earshot is connected. You can close this tab."),
            (_, _, Some(err)) => (Err(format!("Sign-in was refused: {err}")), "Sign-in was cancelled. You can close this tab."),
            _ => (Err("Sign-in response didn't match (state mismatch)".to_string()), "Something went wrong. Close this tab and try again."),
        };
        let html = format!("<html><body style=\"font-family:-apple-system;padding:40px\"><h2>{body}</h2></body></html>");
        let _ = stream.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\n\r\n{html}", html.len()).as_bytes());
        return ok;
    }
}

fn oauth_sign_in(id: &str, server_url: &str) -> Result<(), String> {
    let (meta, resource) = discover(server_url)?;
    let authorize = meta["authorization_endpoint"].as_str().ok_or("server has no authorization endpoint")?;
    let token_endpoint = meta["token_endpoint"].as_str().ok_or("server has no token endpoint")?.to_string();
    let scopes: Vec<String> = meta["scopes_supported"].as_array().map(|a| a.iter().filter_map(|s| s.as_str().map(String::from)).collect()).unwrap_or_default();

    let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    let redirect = format!("http://127.0.0.1:{}/callback", listener.local_addr().map_err(|e| e.to_string())?.port());

    // Dynamic client registration (RFC 7591), as a public client using PKCE.
    let registration = meta["registration_endpoint"].as_str().ok_or("server doesn't support client registration")?;
    let reg: Value = agent()
        .post(registration)
        .send_json(json!({
            "client_name": "Earshot",
            "redirect_uris": [redirect],
            "grant_types": ["authorization_code", "refresh_token"],
            "response_types": ["code"],
            "token_endpoint_auth_method": "none",
        }))
        .map_err(|e| format!("client registration failed: {e}"))?
        .into_json()
        .map_err(|e| e.to_string())?;
    let client_id = reg["client_id"].as_str().ok_or("registration returned no client_id")?.to_string();

    let verifier = random_token(48);
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    let state = random_token(16);
    let mut auth_url = url::Url::parse(authorize).map_err(|e| e.to_string())?;
    auth_url
        .query_pairs_mut()
        .append_pair("response_type", "code")
        .append_pair("client_id", &client_id)
        .append_pair("redirect_uri", &redirect)
        .append_pair("code_challenge", &challenge)
        .append_pair("code_challenge_method", "S256")
        .append_pair("state", &state)
        .append_pair("resource", &resource)
        .append_pair("scope", &scopes.join(" "));
    std::process::Command::new("open").arg(auth_url.as_str()).spawn().map_err(|e| e.to_string())?;
    logging::info("mcp", &format!("{id}: opened browser for sign-in"));

    let code = wait_for_code(listener, &state)?;
    let token: Value = agent()
        .post(&token_endpoint)
        .send_form(&[
            ("grant_type", "authorization_code"),
            ("code", &code),
            ("redirect_uri", &redirect),
            ("client_id", &client_id),
            ("code_verifier", &verifier),
            ("resource", &resource),
        ])
        .map_err(|e| format!("token exchange failed: {e}"))?
        .into_json()
        .map_err(|e| e.to_string())?;
    let creds = Credentials {
        client_id,
        token_endpoint,
        access_token: token["access_token"].as_str().ok_or("no access_token in token response")?.to_string(),
        refresh_token: token["refresh_token"].as_str().map(String::from),
        expires_at: token["expires_in"].as_u64().map(|s| now() + s),
        resource,
    };
    save_creds(id, &creds)?;
    logging::info("mcp", &format!("{id}: signed in"));
    Ok(())
}

fn refresh(id: &str, creds: &mut Credentials) -> Result<(), String> {
    let refresh_token = creds.refresh_token.clone().ok_or("Session expired — sign in again in Settings → Integrations")?;
    let token: Value = agent()
        .post(&creds.token_endpoint)
        .send_form(&[
            ("grant_type", "refresh_token"),
            ("refresh_token", &refresh_token),
            ("client_id", &creds.client_id),
            ("resource", &creds.resource),
        ])
        .map_err(|e| format!("Session expired — sign in again in Settings → Integrations ({e})"))?
        .into_json()
        .map_err(|e| e.to_string())?;
    creds.access_token = token["access_token"].as_str().ok_or("no access_token in refresh response")?.to_string();
    if let Some(r) = token["refresh_token"].as_str() {
        creds.refresh_token = Some(r.to_string());
    }
    creds.expires_at = token["expires_in"].as_u64().map(|s| now() + s);
    save_creds(id, creds)
}

/// Per-server MCP session (from initialize), reused across calls.
fn sessions() -> &'static Mutex<HashMap<String, Option<String>>> {
    static S: OnceLock<Mutex<HashMap<String, Option<String>>>> = OnceLock::new();
    S.get_or_init(Default::default)
}

/// Streamable HTTP replies with plain JSON or an SSE stream; take the JSON-RPC response either way.
fn parse_reply(resp: ureq::Response, id: u64) -> Result<(Option<String>, Value), String> {
    let session = resp.header("mcp-session-id").map(String::from);
    let is_sse = resp.content_type().contains("event-stream");
    let mut body = String::new();
    resp.into_reader().take(64 * 1024 * 1024).read_to_string(&mut body).map_err(|e| e.to_string())?;
    let messages: Vec<Value> = if is_sse {
        body.lines().filter_map(|l| l.strip_prefix("data:")).filter_map(|d| serde_json::from_str(d.trim()).ok()).collect()
    } else if body.trim().is_empty() {
        vec![]
    } else {
        vec![serde_json::from_str(&body).map_err(|e| format!("bad JSON from server: {e}"))?]
    };
    let reply = messages.into_iter().find(|m| m["id"].as_u64() == Some(id)).unwrap_or(Value::Null);
    if let Some(err) = reply.get("error") {
        return Err(format!("server error: {}", err["message"].as_str().unwrap_or(&err.to_string())));
    }
    Ok((session, reply["result"].clone()))
}

enum Failure {
    Unauthorized,
    SessionGone,
    Other(String),
}

fn post_rpc(url: &str, token: &str, session: Option<&str>, method: &str, params: Value, id: Option<u64>) -> Result<(Option<String>, Value), Failure> {
    let mut req = agent()
        .post(url)
        .set("content-type", "application/json")
        .set("accept", "application/json, text/event-stream")
        .set("mcp-protocol-version", PROTOCOL)
        .set("authorization", &format!("Bearer {token}"));
    if let Some(s) = session {
        req = req.set("mcp-session-id", s);
    }
    let body = match id {
        Some(id) => json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }),
        None => json!({ "jsonrpc": "2.0", "method": method, "params": params }),
    };
    match req.send_json(body) {
        Ok(resp) => match id {
            Some(id) => parse_reply(resp, id).map_err(Failure::Other),
            None => Ok((None, Value::Null)),
        },
        Err(ureq::Error::Status(401, _)) => Err(Failure::Unauthorized),
        Err(ureq::Error::Status(404, _)) if session.is_some() => Err(Failure::SessionGone),
        Err(ureq::Error::Status(code, resp)) => Err(Failure::Other(format!("{method}: HTTP {code} {}", resp.into_string().unwrap_or_default().chars().take(300).collect::<String>()))),
        Err(e) => Err(Failure::Other(format!("{method}: {e}"))),
    }
}

static NEXT_ID: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

/// One JSON-RPC request with initialize-on-demand, token refresh and session recovery.
pub fn request(id: &str, url: &str, method: &str, params: Value) -> Result<Value, String> {
    let mut creds = load_creds(id).ok_or("Not connected — sign in under Settings → Integrations")?;
    if creds.expires_at.is_some_and(|t| t <= now() + 30) {
        refresh(id, &mut creds)?;
    }
    for attempt in 0..3 {
        let session = sessions().lock().unwrap().get(id).cloned();
        let session = match session {
            Some(s) => s,
            None => {
                let rpc_id = NEXT_ID.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                let init = json!({ "protocolVersion": PROTOCOL, "capabilities": {}, "clientInfo": { "name": "Earshot", "version": env!("CARGO_PKG_VERSION") } });
                match post_rpc(url, &creds.access_token, None, "initialize", init, Some(rpc_id)) {
                    Ok((s, _)) => {
                        let _ = post_rpc(url, &creds.access_token, s.as_deref(), "notifications/initialized", json!({}), None);
                        sessions().lock().unwrap().insert(id.to_string(), s.clone());
                        s
                    }
                    Err(Failure::Unauthorized) if attempt == 0 => {
                        refresh(id, &mut creds)?;
                        continue;
                    }
                    Err(Failure::Unauthorized) => return Err("Not authorized — sign in again under Settings → Integrations".into()),
                    Err(Failure::SessionGone) => continue,
                    Err(Failure::Other(e)) => return Err(e),
                }
            }
        };
        let rpc_id = NEXT_ID.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        match post_rpc(url, &creds.access_token, session.as_deref(), method, params.clone(), Some(rpc_id)) {
            Ok((_, result)) => return Ok(result),
            Err(Failure::Unauthorized) if attempt == 0 => {
                refresh(id, &mut creds)?;
                sessions().lock().unwrap().remove(id);
            }
            Err(Failure::SessionGone) => {
                sessions().lock().unwrap().remove(id);
            }
            Err(Failure::Unauthorized) => return Err("Not authorized — sign in again under Settings → Integrations".into()),
            Err(Failure::Other(e)) => return Err(e),
        }
    }
    Err(format!("{method}: gave up after retries"))
}

#[tauri::command]
pub async fn mcp_connect(id: String, url: String) -> Result<(), String> {
    blocking(move || {
        sessions().lock().unwrap().remove(&id);
        oauth_sign_in(&id, &url).inspect_err(|e| logging::error("mcp", &format!("{id}: sign-in failed: {e}")))
    })
    .await
}

#[tauri::command]
pub async fn mcp_disconnect(id: String) -> Result<(), String> {
    blocking(move || {
        sessions().lock().unwrap().remove(&id);
        match keychain(&id)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    })
    .await
}

#[tauri::command]
pub async fn mcp_status(id: String) -> Result<bool, String> {
    blocking(move || Ok(load_creds(&id).is_some())).await
}

#[tauri::command]
pub async fn mcp_tools(id: String, url: String) -> Result<Value, String> {
    blocking(move || Ok(request(&id, &url, "tools/list", json!({}))?["tools"].clone())).await
}

#[tauri::command]
pub async fn mcp_call(id: String, url: String, tool: String, args: Value) -> Result<Value, String> {
    blocking(move || {
        let started = std::time::Instant::now();
        let result = request(&id, &url, "tools/call", json!({ "name": tool, "arguments": args }));
        logging::info("mcp", &format!("{id}.{tool}: {} in {} ms", if result.is_ok() { "ok" } else { "error" }, started.elapsed().as_millis()));
        result
    })
    .await
}
