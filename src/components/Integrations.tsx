// Settings → Integrations: MCP connectors topics can be backed by.

import { useEffect, useState } from "react";
import type { ConnectorDef, McpTool } from "../core/connectors";
import { addCustomConnector, connectors, mcpConnect, mcpDisconnect, mcpStatus, mcpTools, removeCustomConnector } from "../lib/integrations";
import { useSettings } from "../lib/settings";
import { IconPlus } from "./icons";

export function IntegrationsSection() {
  useSettings(); // re-render when custom connectors change
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("https://");

  return (
    <section>
      <h2>Integrations</h2>
      <p className="muted">
        Connect MCP servers so a topic can be backed by a page elsewhere: Earshot pulls it before each session and, after the call, a skill drafts
        the record and writes it back once you approve. Sign-in happens in your browser; tokens stay in the macOS keychain.
      </p>
      <div className="providers">
        {connectors().map((c) => (
          <ConnectorRow key={c.id} def={c} />
        ))}
      </div>
      {adding ? (
        <form
          className="provider"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!name.trim() || !/^https?:\/\//.test(url)) return;
            await addCustomConnector(name.trim(), url.trim());
            setAdding(false);
            setName("");
            setUrl("https://");
          }}
        >
          <div className="provider-inputs">
            <input autoFocus value={name} placeholder="Name, e.g. Linear" onChange={(e) => setName(e.target.value)} />
            <input value={url} placeholder="MCP server URL" onChange={(e) => setUrl(e.target.value)} />
            <button className="btn small primary" type="submit">
              Add
            </button>
            <button className="btn small ghost" type="button" onClick={() => setAdding(false)}>
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <button className="btn small" onClick={() => setAdding(true)}>
          <IconPlus size={14} /> Add MCP server
        </button>
      )}
    </section>
  );
}

function ConnectorRow({ def }: { def: ConnectorDef }) {
  const [connected, setConnected] = useState<boolean | null>(null);
  const [busy, setBusy] = useState("");
  const [result, setResult] = useState("");
  const [tools, setTools] = useState<McpTool[] | null>(null);

  useEffect(() => {
    mcpStatus(def.id).then(setConnected).catch(() => setConnected(false));
  }, [def.id]);

  const connect = async () => {
    setBusy("Finish signing in in your browser…");
    setResult("");
    try {
      await mcpConnect(def.id, def.url);
      setConnected(true);
      await test();
    } catch (e) {
      setResult(`✗ ${String(e).replace(/^Error: /, "")}`);
    } finally {
      setBusy("");
    }
  };

  const test = async () => {
    setBusy("Checking…");
    try {
      const list = await mcpTools(def.id, def.url);
      setTools(list);
      const mapped = [def.read?.tool, ...Object.values(def.write ?? {}).map((w) => w?.tool)].filter(Boolean) as string[];
      const missing = mapped.filter((t) => !list.some((x) => x.name === t));
      setResult(missing.length ? `✗ Connected, but the server has no ${missing.join(", ")} tool — the mapping needs updating` : `✓ Connected · ${list.length} tools`);
    } catch (e) {
      setResult(`✗ ${String(e).replace(/^Error: /, "")}`);
    } finally {
      setBusy("");
    }
  };

  return (
    <div className="provider">
      <div className="provider-head">
        <strong>{def.name}</strong>
        <span className="tag">{def.read ? "mapped" : "agent"}</span>
        {connected !== null && <span className={connected ? "ok small" : "muted small"}>{connected ? "connected" : "not connected"}</span>}
        {!def.builtin && (
          <button className="link" onClick={() => removeCustomConnector(def.id)}>
            remove
          </button>
        )}
      </div>
      <small className="muted">
        {def.description} <code>{def.url}</code>
      </small>
      <div className="toolbar">
        {connected ? (
          <>
            <button className="btn small" disabled={!!busy} onClick={test}>
              Test
            </button>
            <button className="btn small ghost" disabled={!!busy} onClick={async () => (await mcpDisconnect(def.id), setConnected(false), setTools(null), setResult(""))}>
              Disconnect
            </button>
          </>
        ) : (
          <button className="btn small primary" disabled={!!busy} onClick={connect}>
            Connect
          </button>
        )}
        {busy && <small className="muted">{busy}</small>}
        {result && <small className={result.startsWith("✓") ? "ok" : "bad"}>{result}</small>}
      </div>
      {tools && (
        <details className="advanced">
          <summary>{tools.length} tools</summary>
          <ul className="tool-list">
            {tools.map((t) => (
              <li key={t.name}>
                <code>{t.name}</code>
                <small className="muted"> ({Object.keys(t.inputSchema?.properties ?? {}).join(", ")})</small>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
