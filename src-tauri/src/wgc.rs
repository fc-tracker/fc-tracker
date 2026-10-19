//! One picture of one window via Windows.Graphics.Capture – the API OBS uses for window
//! capture. It sees the window's own content only: our overlay, list and toast on top of the
//! game are not in it, so nothing of ours has to be hidden for a read (no flicker in the
//! user's recordings). Reads only pixels the compositor already has; never touches the game
//! process. Each call starts a session, takes one frame and closes it again – no continuous
//! capture.

use windows::core::Interface;
use windows::Graphics::Capture::{Direct3D11CaptureFramePool, GraphicsCaptureItem};
use windows::Graphics::DirectX::Direct3D11::IDirect3DDevice;
use windows::Graphics::DirectX::DirectXPixelFormat;
use windows::Win32::Foundation::{HMODULE, HWND};
use windows::Win32::Graphics::Direct3D::D3D_DRIVER_TYPE_HARDWARE;
use windows::Win32::Graphics::Direct3D11::{
    D3D11CreateDevice, ID3D11Device, ID3D11DeviceContext, ID3D11Texture2D, D3D11_CPU_ACCESS_READ, D3D11_CREATE_DEVICE_BGRA_SUPPORT,
    D3D11_MAPPED_SUBRESOURCE, D3D11_MAP_READ, D3D11_SDK_VERSION, D3D11_TEXTURE2D_DESC, D3D11_USAGE_STAGING,
};
use windows::Win32::Graphics::Dxgi::IDXGIDevice;
use windows::Win32::System::WinRT::Direct3D11::{CreateDirect3D11DeviceFromDXGIDevice, IDirect3DDxgiInterfaceAccess};
use windows::Win32::System::WinRT::Graphics::Capture::IGraphicsCaptureItemInterop;

fn err(e: windows::core::Error) -> String {
    format!("wgc:{e}")
}

thread_local! {
    /// One D3D11 device per thread, made on the first capture (saves ~100 ms per read).
    static DEVICES: std::cell::RefCell<Option<(ID3D11Device, ID3D11DeviceContext, IDirect3DDevice)>> = const { std::cell::RefCell::new(None) };
}

pub(crate) fn devices() -> Result<(ID3D11Device, ID3D11DeviceContext, IDirect3DDevice), String> {
    DEVICES.with(|cell| {
        if let Some(d) = cell.borrow().as_ref() {
            return Ok(d.clone());
        }
        // SAFETY: plain D3D11 device creation; the objects are kept for this thread.
        let made = unsafe {
            let mut device: Option<ID3D11Device> = None;
            let mut context: Option<ID3D11DeviceContext> = None;
            D3D11CreateDevice(
                None,
                D3D_DRIVER_TYPE_HARDWARE,
                HMODULE::default(),
                D3D11_CREATE_DEVICE_BGRA_SUPPORT,
                None,
                D3D11_SDK_VERSION,
                Some(&mut device),
                None,
                Some(&mut context),
            )
            .map_err(err)?;
            let (device, context) = (device.ok_or("wgc:no_device")?, context.ok_or("wgc:no_context")?);
            let dxgi: IDXGIDevice = device.cast().map_err(err)?;
            let d3d: IDirect3DDevice = CreateDirect3D11DeviceFromDXGIDevice(&dxgi).map_err(err)?.cast().map_err(err)?;
            (device, context, d3d)
        };
        *cell.borrow_mut() = Some(made.clone());
        Ok(made)
    })
}

/// BGRA pixels (alpha 255) of the window's content, or an error to fall back on.
pub fn capture_window(hwnd: HWND) -> Result<(u32, u32, Vec<u8>), String> {
    // SAFETY: D3D11/WinRT interop calls on objects created and released within this function;
    // the window handle comes from EnumWindows and only identifies what to capture.
    unsafe {
        let (device, context, d3d) = devices()?;
        let interop = windows::core::factory::<GraphicsCaptureItem, IGraphicsCaptureItemInterop>().map_err(err)?;
        let item: GraphicsCaptureItem = interop.CreateForWindow(hwnd).map_err(err)?;
        let size = item.Size().map_err(err)?;
        let pool = Direct3D11CaptureFramePool::CreateFreeThreaded(&d3d, DirectXPixelFormat::B8G8R8A8UIntNormalized, 1, size).map_err(err)?;
        let session = pool.CreateCaptureSession(&item).map_err(err)?;
        // No yellow "being captured" frame around the game, no mouse cursor in the picture.
        // (Windows 11 accepts this for desktop apps without asking: verified, the session then
        // reports IsBorderRequired = false.)
        let _ = session.SetIsBorderRequired(false);
        let _ = session.SetIsCursorCaptureEnabled(false);
        session.StartCapture().map_err(err)?;

        let started = std::time::Instant::now();
        let frame = loop {
            if let Ok(f) = pool.TryGetNextFrame() {
                break f;
            }
            if started.elapsed() > std::time::Duration::from_millis(700) {
                let _ = session.Close();
                let _ = pool.Close();
                return Err("wgc:no_frame".into());
            }
            std::thread::sleep(std::time::Duration::from_millis(4));
        };

        let content = frame.ContentSize().map_err(err)?;
        let texture: ID3D11Texture2D = frame.Surface().map_err(err)?.cast::<IDirect3DDxgiInterfaceAccess>().map_err(err)?.GetInterface().map_err(err)?;
        let mut desc = D3D11_TEXTURE2D_DESC::default();
        texture.GetDesc(&mut desc);
        desc.Usage = D3D11_USAGE_STAGING;
        desc.BindFlags = 0;
        desc.CPUAccessFlags = D3D11_CPU_ACCESS_READ.0 as u32;
        desc.MiscFlags = 0;
        let mut staging: Option<ID3D11Texture2D> = None;
        device.CreateTexture2D(&desc, None, Some(&mut staging)).map_err(err)?;
        let staging = staging.ok_or("wgc:no_staging")?;
        context.CopyResource(&staging, &texture);

        let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
        context.Map(&staging, 0, D3D11_MAP_READ, 0, Some(&mut mapped)).map_err(err)?;
        let w = (content.Width.max(0) as u32).min(desc.Width);
        let h = (content.Height.max(0) as u32).min(desc.Height);
        let mut pixels = vec![0u8; (w * h * 4) as usize];
        for y in 0..h as usize {
            let src = std::slice::from_raw_parts((mapped.pData as *const u8).add(y * mapped.RowPitch as usize), (w * 4) as usize);
            pixels[y * (w * 4) as usize..(y + 1) * (w * 4) as usize].copy_from_slice(src);
        }
        context.Unmap(&staging, 0);
        let _ = frame.Close();
        let _ = session.Close();
        let _ = pool.Close();

        if w == 0 || h == 0 {
            return Err("wgc:empty".into());
        }
        for px in pixels.chunks_exact_mut(4) {
            px[3] = 255;
        }
        // An all-black picture means the window could not be captured (e.g. exclusive fullscreen).
        if pixels.chunks_exact(4).step_by(997).all(|p| p[0] < 4 && p[1] < 4 && p[2] < 4) {
            return Err("wgc:black".into());
        }
        Ok((w, h, pixels))
    }
}

#[cfg(test)]
mod tests {
    /// Captures the foreground window and writes it as a BMP (FCT_WGC_OUT) to look at.
    /// `FCT_WGC_OUT=<file.bmp> cargo test --lib wgc -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn captures_the_foreground_window() {
        let Ok(out) = std::env::var("FCT_WGC_OUT") else { return };
        // SAFETY: plain query of the foreground window handle.
        let hwnd = unsafe { windows::Win32::UI::WindowsAndMessaging::GetForegroundWindow() };
        let t0 = std::time::Instant::now();
        let (w, h, px) = super::capture_window(hwnd).expect("capture");
        println!("captured {w}×{h} in {} ms", t0.elapsed().as_millis());
        let t1 = std::time::Instant::now();
        let _ = super::capture_window(hwnd).expect("second capture");
        println!("second capture in {} ms", t1.elapsed().as_millis());
        let row = (w * 4) as usize;
        let mut bmp = Vec::new();
        let size = 54 + px.len() as u32;
        bmp.extend_from_slice(b"BM");
        bmp.extend_from_slice(&size.to_le_bytes());
        bmp.extend_from_slice(&[0; 4]);
        bmp.extend_from_slice(&54u32.to_le_bytes());
        bmp.extend_from_slice(&40u32.to_le_bytes());
        bmp.extend_from_slice(&(w as i32).to_le_bytes());
        bmp.extend_from_slice(&(-(h as i32)).to_le_bytes());
        bmp.extend_from_slice(&1u16.to_le_bytes());
        bmp.extend_from_slice(&32u16.to_le_bytes());
        bmp.extend_from_slice(&[0; 24]);
        for y in 0..h as usize {
            bmp.extend_from_slice(&px[y * row..(y + 1) * row]);
        }
        std::fs::write(out, bmp).unwrap();
    }
}

