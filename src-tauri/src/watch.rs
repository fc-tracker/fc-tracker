//! Continuous watching of the game window in the menus (setting `continuous`). One
//! Windows.Graphics.Capture session stays open; each look takes the newest frame, scales it down
//! on the GPU (mipmaps) and reads back only a ~64-px-wide picture → the page-change signature.
//! Full-size reads still use `wgc::capture_window`. Never touches the game process. Stops in a
//! match, when the game window is gone, or when the setting is off.

use std::sync::Mutex;
use std::time::{Duration, Instant};
use windows::core::Interface;
use windows::Graphics::Capture::{Direct3D11CaptureFramePool, GraphicsCaptureItem, GraphicsCaptureSession};
use windows::Graphics::DirectX::DirectXPixelFormat;
use windows::Graphics::SizeInt32;
use windows::Win32::Foundation::HWND;
use windows::Win32::Graphics::Direct3D11::{
    ID3D11Texture2D, D3D11_BIND_RENDER_TARGET, D3D11_BIND_SHADER_RESOURCE, D3D11_BOX, D3D11_CPU_ACCESS_READ, D3D11_MAPPED_SUBRESOURCE,
    D3D11_MAP_READ, D3D11_RESOURCE_MISC_GENERATE_MIPS, D3D11_TEXTURE2D_DESC, D3D11_USAGE_DEFAULT, D3D11_USAGE_STAGING,
};
use windows::Win32::Graphics::Dxgi::Common::{DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_SAMPLE_DESC};
use windows::Win32::System::WinRT::Direct3D11::IDirect3DDxgiInterfaceAccess;
use windows::Win32::System::WinRT::Graphics::Capture::IGraphicsCaptureItemInterop;

/// The newest signature and when it was made.
static LATEST: Mutex<Option<(Vec<u8>, Instant)>> = Mutex::new(None);

type Picture = Result<(u32, u32, Vec<u8>), String>;
/// A full-size picture asked for by a read (served by the watcher thread, which owns the capture).
/** No new frame for this long: the held picture may be old – reopen the capture. */
const STALL: Duration = Duration::from_secs(2);
/** A new session's first frame can take over 2 s (measured 0.23–2.44 s): wait this long for it. */
const FIRST_FRAME_WAIT: Duration = Duration::from_secs(5);
/** While a recorder runs, a stalled session is replaced at most this often. */
const STEADY_REOPEN: Duration = Duration::from_secs(30);
/** A held frame younger than this counts as the current picture for a read. */
const FRESH: Duration = Duration::from_millis(300);

static REQUEST: Mutex<Option<std::sync::mpsc::Sender<Picture>>> = Mutex::new(None);
/// Wakes the watcher early for a request.
static WAKE: (Mutex<bool>, std::sync::Condvar) = (Mutex::new(false), std::sync::Condvar::new());

/// The game window in full size from the running capture – no new capture session (≈ 87 ms
/// saved per read). `None`: not watching right now (the caller captures on its own).
pub fn full_frame(timeout: Duration) -> Option<Picture> {
    LATEST.lock().unwrap().as_ref()?;
    let (tx, rx) = std::sync::mpsc::channel();
    *REQUEST.lock().unwrap() = Some(tx);
    *WAKE.0.lock().unwrap() = true;
    WAKE.1.notify_one();
    rx.recv_timeout(timeout).ok()
}

/// Sleeps `every`, or less when a read asks for a picture.
fn wait(every: Duration) {
    let guard = WAKE.0.lock().unwrap();
    let (mut woken, _) = WAKE.1.wait_timeout_while(guard, every, |w| !*w).unwrap();
    *woken = false;
}

/// The newest signature, if it is younger than `max_age` (the watcher is running and seeing frames).
pub fn fresh_signature(max_age: Duration) -> Option<Vec<u8>> {
    LATEST.lock().unwrap().as_ref().filter(|(_, at)| at.elapsed() <= max_age).map(|(s, _)| s.clone())
}

fn err(e: windows::core::Error) -> String {
    format!("watch:{e}")
}

/// An open capture of one window.
struct Watch {
    hwnd: isize,
    size: SizeInt32,
    pool: Direct3D11CaptureFramePool,
    session: GraphicsCaptureSession,
    /// Full-size texture with a mip chain, and the staging copy of the small mip level.
    mips: Option<(ID3D11Texture2D, u32, ID3D11Texture2D, u32, u32)>,
    /// Full-size staging texture for reads (made on the first one).
    full: Option<ID3D11Texture2D>,
}

impl Watch {
    fn open(hwnd: HWND) -> Result<Self, String> {
        let (_, _, d3d) = crate::wgc::devices()?;
        // SAFETY: WinRT interop on a window handle from EnumWindows; objects are owned by Watch.
        unsafe {
            let interop = windows::core::factory::<GraphicsCaptureItem, IGraphicsCaptureItemInterop>().map_err(err)?;
            let item: GraphicsCaptureItem = interop.CreateForWindow(hwnd).map_err(err)?;
            let size = item.Size().map_err(err)?;
            let pool = Direct3D11CaptureFramePool::CreateFreeThreaded(&d3d, DirectXPixelFormat::B8G8R8A8UIntNormalized, 2, size).map_err(err)?;
            let session = pool.CreateCaptureSession(&item).map_err(err)?;
            let _ = session.SetIsBorderRequired(false);
            let _ = session.SetIsCursorCaptureEnabled(false);
            session.StartCapture().map_err(err)?;
            Ok(Self { hwnd: hwnd.0 as isize, size, pool, session, mips: None, full: None })
        }
    }

    fn close(self) {
        let _ = self.session.Close();
        let _ = self.pool.Close();
    }

    /// The newest picture in full size (mip level 0 holds the last frame seen).
    fn full_picture(&mut self) -> Picture {
        let (device, context, _) = crate::wgc::devices()?;
        let Some((mip_tex, ..)) = self.mips.as_ref() else { return Err("watch:no_frame_yet".into()) };
        let (w, h) = (self.size.Width.max(1) as u32, self.size.Height.max(1) as u32);
        // SAFETY: D3D11 calls on textures owned by this Watch.
        unsafe {
            if self.full.is_none() {
                let desc = D3D11_TEXTURE2D_DESC {
                    Width: w,
                    Height: h,
                    MipLevels: 1,
                    ArraySize: 1,
                    Format: DXGI_FORMAT_B8G8R8A8_UNORM,
                    SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
                    Usage: D3D11_USAGE_STAGING,
                    BindFlags: 0,
                    CPUAccessFlags: D3D11_CPU_ACCESS_READ.0 as u32,
                    MiscFlags: 0,
                };
                let mut t = None;
                device.CreateTexture2D(&desc, None, Some(&mut t)).map_err(err)?;
                self.full = t;
            }
            let full = self.full.as_ref().ok_or("watch:no_full")?;
            context.CopySubresourceRegion(full, 0, 0, 0, 0, mip_tex, 0, None);
            let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
            context.Map(full, 0, D3D11_MAP_READ, 0, Some(&mut mapped)).map_err(err)?;
            let mut px = vec![0u8; (w * h * 4) as usize];
            for y in 0..h as usize {
                let src = std::slice::from_raw_parts((mapped.pData as *const u8).add(y * mapped.RowPitch as usize), (w * 4) as usize);
                px[y * (w * 4) as usize..(y + 1) * (w * 4) as usize].copy_from_slice(src);
            }
            context.Unmap(full, 0);
            for p in px.chunks_exact_mut(4) {
                p[3] = 255;
            }
            if px.chunks_exact(4).step_by(997).all(|p| p[0] < 4 && p[1] < 4 && p[2] < 4) {
                return Err("watch:black".into());
            }
            Ok((w, h, px))
        }
    }

    /// The newest frame since the last look, as a signature. `Ok(None)`: no new frame (the
    /// window didn't change). `Err`: the capture must be reopened.
    fn look(&mut self) -> Result<Option<Vec<u8>>, String> {
        // drain: keep only the newest frame
        let mut newest = None;
        while let Ok(f) = self.pool.TryGetNextFrame() {
            if let Some(old) = newest.replace(f) {
                let _ = old.Close();
            }
        }
        let Some(frame) = newest else { return Ok(None) };
        let size = frame.ContentSize().map_err(err)?;
        if size.Width != self.size.Width || size.Height != self.size.Height {
            let _ = frame.Close();
            return Err("watch:resized".into());
        }
        let (device, context, _) = crate::wgc::devices()?;
        // SAFETY: D3D11 calls on textures owned by this Watch / the frame (closed below).
        let result = unsafe {
            let texture: ID3D11Texture2D = frame.Surface().map_err(err)?.cast::<IDirect3DDxgiInterfaceAccess>().map_err(err)?.GetInterface().map_err(err)?;
            let (w, h) = (size.Width.max(1) as u32, size.Height.max(1) as u32);
            if self.mips.is_none() {
                // the smallest mip level that is still ≥ 64 × 36
                let mut level = 0u32;
                while (w >> (level + 1)) >= 64 && (h >> (level + 1)) >= 36 {
                    level += 1;
                }
                let desc = D3D11_TEXTURE2D_DESC {
                    Width: w,
                    Height: h,
                    MipLevels: level + 1,
                    ArraySize: 1,
                    Format: DXGI_FORMAT_B8G8R8A8_UNORM,
                    SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
                    Usage: D3D11_USAGE_DEFAULT,
                    BindFlags: (D3D11_BIND_SHADER_RESOURCE.0 | D3D11_BIND_RENDER_TARGET.0) as u32,
                    CPUAccessFlags: 0,
                    MiscFlags: D3D11_RESOURCE_MISC_GENERATE_MIPS.0 as u32,
                };
                let mut mip_tex = None;
                device.CreateTexture2D(&desc, None, Some(&mut mip_tex)).map_err(err)?;
                let (sw, sh) = ((w >> level).max(1), (h >> level).max(1));
                let sdesc = D3D11_TEXTURE2D_DESC {
                    Width: sw,
                    Height: sh,
                    MipLevels: 1,
                    ArraySize: 1,
                    Format: DXGI_FORMAT_B8G8R8A8_UNORM,
                    SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
                    Usage: D3D11_USAGE_STAGING,
                    BindFlags: 0,
                    CPUAccessFlags: D3D11_CPU_ACCESS_READ.0 as u32,
                    MiscFlags: 0,
                };
                let mut staging = None;
                device.CreateTexture2D(&sdesc, None, Some(&mut staging)).map_err(err)?;
                self.mips = Some((mip_tex.ok_or("watch:no_mips")?, level, staging.ok_or("watch:no_staging")?, sw, sh));
            }
            let (mip_tex, level, staging, sw, sh) = self.mips.as_ref().unwrap();
            let src_box = D3D11_BOX { left: 0, top: 0, front: 0, right: w, bottom: h, back: 1 };
            context.CopySubresourceRegion(mip_tex, 0, 0, 0, 0, &texture, 0, Some(&src_box));
            let mut srv = None;
            device.CreateShaderResourceView(mip_tex, None, Some(&mut srv)).map_err(err)?;
            context.GenerateMips(&srv.ok_or("watch:no_srv")?);
            context.CopySubresourceRegion(staging, 0, 0, 0, 0, mip_tex, *level, None);
            let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
            context.Map(staging, 0, D3D11_MAP_READ, 0, Some(&mut mapped)).map_err(err)?;
            let mut px = vec![0u8; (*sw * *sh * 4) as usize];
            for y in 0..*sh as usize {
                let src = std::slice::from_raw_parts((mapped.pData as *const u8).add(y * mapped.RowPitch as usize), (*sw * 4) as usize);
                px[y * (*sw * 4) as usize..(y + 1) * (*sw * 4) as usize].copy_from_slice(src);
            }
            context.Unmap(staging, 0);
            Ok(Some(crate::scan::signature_from_pixels(*sw, *sh, &px)))
        };
        let _ = frame.Close();
        result
    }
}

/// The watcher thread: runs for the whole app, opens the capture only when it should run.
/// `should_run` → Some(look interval) while the user is in the menus with the setting on.
pub fn spawn(should_run: impl Fn() -> Option<Duration> + Send + 'static, log: impl Fn(&str) + Send + 'static) {
    std::thread::Builder::new()
        .name("watch".into())
        .spawn(move || {
            let mut watch: Option<Watch> = None;
            let mut failures = 0u32;
            // No frame for STALL: the picture we hold may be old (a still menu sends none, and
            // FC 27 presented "like fullscreen" sends none to window capture at all – live
            // 2026-10-17: 0 frames for minutes, reads saw an old screen). A new session always
            // starts with the current picture, so reopen – quietly, logged only on a change.
            let mut stalled = false;
            let mut running = false;
            // frames since the capture was (re)opened: its first one comes anyway, a second means they flow
            let mut since_open = 0u32;
            // A capture that stops delivering frames is reopened, not trusted forever.
            let mut last_frame = Instant::now();
            // when a stalled session was last replaced while a recorder runs
            let mut steady_reopen: Option<Instant> = None;
            loop {
                let Some(every) = should_run() else {
                    if let Some(w) = watch.take() {
                        w.close();
                    }
                    if running {
                        running = false;
                        stalled = false;
                        log("watch: continuous watching stopped");
                    }
                    *LATEST.lock().unwrap() = None;
                    std::thread::sleep(Duration::from_millis(300));
                    continue;
                };
                let Some(hwnd) = crate::scan::game_window() else {
                    if let Some(w) = watch.take() {
                        w.close();
                    }
                    *LATEST.lock().unwrap() = None;
                    std::thread::sleep(Duration::from_millis(500));
                    continue;
                };
                if watch.as_ref().is_some_and(|w| w.hwnd != hwnd.0 as isize) {
                    watch.take().unwrap().close();
                    *LATEST.lock().unwrap() = None;
                }
                if watch.is_none() {
                    match Watch::open(hwnd) {
                        Ok(w) => {
                            if !running {
                                running = true;
                                log("watch: continuous watching of the game window started");
                            }
                            failures = 0;
                            since_open = 0;
                            last_frame = Instant::now();
                            watch = Some(w);
                        }
                        Err(e) => {
                            failures += 1;
                            if failures == 1 {
                                log(&format!("watch: can't watch the game window ({e}) – looks fall back to the screen copy"));
                            }
                            // back off: 1 s, 2 s, … up to 30 s
                            std::thread::sleep(Duration::from_secs(failures.min(30) as u64));
                            continue;
                        }
                    }
                }
                wait(every);
                let request = REQUEST.lock().unwrap().take();
                let looked = watch.as_mut().unwrap().look();
                if let Some(tx) = request {
                    // A read waits: the frame of the look above in full size – only when it is
                    // current. Otherwise the read takes a new one-frame capture (never an old picture).
                    // (while a recorder runs the held picture is used too – no new session for a read)
                    // (while a recorder runs the held picture is used too, but only up to STALL old – an
                    // older one is never read: the caller takes the screen copy instead)
                    let steady = crate::scan::STEADY.load(std::sync::atomic::Ordering::Relaxed);
                    let fresh = matches!(looked, Ok(Some(_))) || last_frame.elapsed() < if steady { STALL } else { FRESH };
                    let _ = tx.send(if fresh { watch.as_mut().unwrap().full_picture() } else { Err("watch:stale".into()) });
                }
                match looked {
                    Ok(Some(sig)) => {
                        last_frame = Instant::now();
                        *LATEST.lock().unwrap() = Some((sig, last_frame));
                        since_open += 1;
                        if stalled && since_open >= 2 {
                            stalled = false;
                            log("watch: the game window sends frames again");
                        }
                    }
                    // no new frame for a moment: the picture didn't change – the last signature holds
                    // (also while a reopened session waits for its first frame) …
                    Ok(None) if last_frame.elapsed() < if since_open == 0 { FIRST_FRAME_WAIT } else { STALL } => {
                        if let Some((_, at)) = LATEST.lock().unwrap().as_mut() {
                            *at = Instant::now();
                        }
                    }
                    // while a recorder runs the session is never reopened (that would disturb the
                    // recording): the held signature ages out, so looks and reads use the screen copy
                    // (live 2026-10-17: after the overlay had covered the game no frame came again –
                    // the screen copy showed the desktop under the game, every read missed)
                    // so a new session is opened *before* the old one closes: the game is never
                    // without a capture, which is what disturbed the recording
                    Ok(None) if crate::scan::STEADY.load(std::sync::atomic::Ordering::Relaxed) => {
                        if !stalled {
                            stalled = true;
                            log("watch: no new frames while a recorder runs – a new session is opened alongside the old one");
                        }
                        // … but not every FIRST_FRAME_WAIT for as long as none come (live 22:52: a new
                        // session every 5 s for the rest of the recording) – each new session on the
                        // game is a change a recording can notice. Meanwhile the screen copy is used.
                        if steady_reopen.is_none_or(|at| at.elapsed() >= STEADY_REOPEN) {
                            steady_reopen = Some(Instant::now());
                            if let Ok(fresh) = Watch::open(hwnd) {
                                if let Some(old) = watch.replace(fresh) {
                                    old.close();
                                }
                                since_open = 0;
                                last_frame = Instant::now();
                            }
                        }
                    }
                    // … not for longer: reopen (its first frame is the current picture)
                    // The last signature stays until the new session's first frame (no switch to the
                    // screen copy in between – that flipped sources and caused needless reads).
                    Ok(None) if since_open == 0 => {
                        // a new session that never delivered: the picture is unknown now
                        *LATEST.lock().unwrap() = None;
                        watch.take().unwrap().close();
                    }
                    Ok(None) => {
                        watch.take().unwrap().close();
                        if !stalled {
                            stalled = true;
                            log("watch: no new frames (a still screen, or the game presented like fullscreen) – refreshing its picture every 2 s");
                        }
                    }
                    Err(_) => {
                        watch.take().unwrap().close();
                        *LATEST.lock().unwrap() = None;
                    }
                }
            }
        })
        .expect("failed to start the watcher");
}

#[cfg(test)]
mod tests {
    /// The watcher's GPU path on a real window (the foreground one): opens, looks, times it.
    /// `cargo test --release --lib watch_real_window -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn watch_real_window() {
        // SAFETY: plain query of the foreground window handle.
        let hwnd = unsafe { windows::Win32::UI::WindowsAndMessaging::GetForegroundWindow() };
        let t = std::time::Instant::now();
        let mut w = super::Watch::open(hwnd).expect("open");
        println!("opened in {:?}", t.elapsed());
        let (mut frames, mut empty) = (0, 0);
        let mut times = Vec::new();
        let mut last = None;
        for _ in 0..60 {
            std::thread::sleep(std::time::Duration::from_millis(16));
            let t = std::time::Instant::now();
            match w.look().expect("look") {
                Some(sig) => {
                    times.push(t.elapsed().as_micros());
                    frames += 1;
                    last = Some(sig);
                }
                None => empty += 1,
            }
        }
        let sig = last.expect("at least one frame");
        let avg = sig.iter().map(|&v| v as u32).sum::<u32>() / sig.len() as u32;
        times.sort();
        println!("{frames} frames, {empty} looks without a new frame; look cost median {} µs, max {} µs; signature {} cells, mean brightness {avg}", times[times.len() / 2], times.last().unwrap(), sig.len());
        assert_eq!(sig.len(), 64 * 36);
        // a read from the running capture (vs ~87 ms for a new one-frame session)
        let mut full_times = Vec::new();
        for _ in 0..5 {
            let t = std::time::Instant::now();
            let (fw, fh, px) = w.full_picture().expect("full picture");
            full_times.push(t.elapsed().as_millis());
            assert_eq!(px.len(), (fw * fh * 4) as usize);
        }
        println!("full picture from the running capture: {:?} ms", full_times);
        // the same picture as a fresh one-frame capture (same size, nearly the same pixels)
        let (fw, fh, a) = w.full_picture().unwrap();
        let (cw, ch, b) = crate::wgc::capture_window(hwnd).expect("one-frame capture");
        let mean = |p: &[u8]| p.iter().step_by(4).map(|&v| v as u64).sum::<u64>() / (p.len() as u64 / 4).max(1);
        println!("sizes {fw}x{fh} vs {cw}x{ch}, mean blue {} vs {}", mean(&a), mean(&b));
        assert_eq!((fw, fh), (cw, ch));
        w.close();
    }
}
