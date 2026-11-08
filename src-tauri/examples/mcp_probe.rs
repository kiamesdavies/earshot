// cargo run --example mcp_probe -- <id> <url> [tool] [json-args]   (credentials must exist in the keychain)
fn main() {
    let a: Vec<String> = std::env::args().collect();
    let tools = earshot_lib::mcp::request(&a[1], &a[2], "tools/list", serde_json::json!({})).expect("tools/list");
    let names: Vec<_> = tools["tools"].as_array().unwrap().iter().map(|t| t["name"].as_str().unwrap().to_string()).collect();
    println!("tools: {names:?}");
    if let Some(tool) = a.get(3) {
        let args: serde_json::Value = serde_json::from_str(a.get(4).map(String::as_str).unwrap_or("{}")).unwrap();
        let r = earshot_lib::mcp::request(&a[1], &a[2], "tools/call", serde_json::json!({ "name": tool, "arguments": args })).expect("call");
        println!("{}", serde_json::to_string(&r).unwrap().chars().take(400).collect::<String>());
    }
}
