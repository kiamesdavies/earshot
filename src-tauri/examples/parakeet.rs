// cargo run --release --example parakeet -- <model_dir> <file.wav>
use std::path::PathBuf;
use std::time::Instant;
use transcribe_rs::onnx::parakeet::{ParakeetModel, ParakeetParams};
use transcribe_rs::onnx::Quantization;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let t = Instant::now();
    let mut model = ParakeetModel::load(&PathBuf::from(&args[1]), &Quantization::Int8).expect("load");
    println!("load {:?}", t.elapsed());
    let samples = transcribe_rs::audio::read_wav_samples(&PathBuf::from(&args[2])).expect("wav");
    let t = Instant::now();
    let r = model.transcribe_with(&samples, &ParakeetParams::default()).expect("transcribe");
    println!("{:.1}s audio in {:?}\n{}", samples.len() as f32 / 16000.0, t.elapsed(), r.text);
}
