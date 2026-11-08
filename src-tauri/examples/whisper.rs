// cargo run --release --example whisper -- <model.bin> <file.wav> [prompt]
use std::path::PathBuf;
use std::time::Instant;
use transcribe_rs::whisper_cpp::{WhisperEngine, WhisperInferenceParams};

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let t = Instant::now();
    let mut model = WhisperEngine::load(&PathBuf::from(&args[1])).expect("load");
    println!("load {:?}", t.elapsed());
    let samples = transcribe_rs::audio::read_wav_samples(&PathBuf::from(&args[2])).expect("wav");
    let params = WhisperInferenceParams { language: Some("en".into()), initial_prompt: args.get(3).cloned(), ..Default::default() };
    let t = Instant::now();
    let r = model.transcribe_with(&samples, &params).expect("transcribe");
    println!("{:.1}s audio in {:?}\n{}", samples.len() as f32 / 16000.0, t.elapsed(), r.text);
}
