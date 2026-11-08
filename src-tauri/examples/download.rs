// cargo run --release --example download -- <model-id> <dest-dir> [cancel-after-secs]
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Instant;

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let cancel = Arc::new(AtomicBool::new(false));
    if let Some(secs) = a.get(3).and_then(|s| s.parse::<u64>().ok()) {
        let c = cancel.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_secs(secs));
            c.store(true, Ordering::Relaxed);
        });
    }
    let started = Instant::now();
    let mut last = 0.0;
    let r = earshot_lib::models::download_to(std::path::Path::new(&a[2]), &a[1], &cancel, |p, got, total| {
        if p - last >= 0.1 {
            last = p;
            println!("{:3.0}%  {} / {} MB", p * 100.0, got >> 20, total >> 20);
        }
    });
    println!("{:?} after {:.1}s", r, started.elapsed().as_secs_f32());
}
