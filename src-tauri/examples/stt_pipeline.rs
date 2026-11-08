// Streams a WAV through the sidecar's live path (`simulate --chunks`) and the
// STT worker, printing each final segment with its delay after speech ended.
// cargo run --release --example stt_pipeline -- <whisper|parakeet> <model> <me.wav> [prompt]
use earshot_lib::stt::{submit, Chunk, Job, SttConfig};
use std::io::{BufRead, BufReader};
use std::process::{Command, Stdio};
use std::time::Instant;

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let config = SttConfig { engine: a[1].clone(), model_path: a[2].clone(), prompt: a.get(4).cloned().unwrap_or_default(), language: "en".into() };
    submit(Job::Configure(config), |m| eprintln!("{m}"));
    let dir = std::env::temp_dir().join("earshot-stt-pipeline");
    let mut child = Command::new(concat!(env!("CARGO_MANIFEST_DIR"), "/../audio/.build/release/earshot-audio"))
        .args(["simulate", "--me", &a[3], "--chunks", "--chunk-dir", dir.to_str().unwrap()])
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let started = Instant::now();
    let (tx, rx) = std::sync::mpsc::channel();
    for line in BufReader::new(child.stdout.take().unwrap()).lines().map_while(Result::ok) {
        let v: serde_json::Value = serde_json::from_str(&line).unwrap();
        if v["type"] == "chunk" {
            let tx = tx.clone();
            let end = v["end"].as_f64().unwrap();
            submit(
                Job::Transcribe(Chunk { id: v["id"].as_str().unwrap().into(), speaker: "me".into(), start: v["start"].as_f64().unwrap(), end, path: v["path"].as_str().unwrap().into() }),
                move |m| {
                    if m["type"] == "segment" {
                        let _ = started;
                        println!("[{:5.1}s] {:4}ms for {:4.1}s audio  {}", m["end"].as_f64().unwrap(), m["sttMs"], m["end"].as_f64().unwrap() - m["start"].as_f64().unwrap(), m["text"].as_str().unwrap());
                    } else {
                        println!("{m}");
                    }
                    let _ = tx.send(());
                },
            );
        }
    }
    let _ = child.wait();
    std::thread::sleep(std::time::Duration::from_secs(4));
    drop(rx);
    earshot_lib::stt::shutdown();
}
