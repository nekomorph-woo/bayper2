use std::{fs, fs::File, path::PathBuf};

use png::{BitDepth, ColorType, Encoder};

fn main() {
    // tauri::generate_context 在编译期强制读取 icons/icon.png，即使 bundle.active=false；
    // 探针源码会被复制到 /tmp 构建，缺失图标时在此生成 1x1 不透明青色 RGBA PNG，不污染仓库。
    let manifest_dir = std::env::var("CARGO_MANIFEST_DIR").expect("未获取到 CARGO_MANIFEST_DIR");
    let icon_path = PathBuf::from(manifest_dir).join("icons/icon.png");
    if !icon_path.exists() {
        let icons_dir = icon_path.parent().expect("图标路径缺少父目录");
        fs::create_dir_all(icons_dir).expect("创建 icons 目录失败");
        let mut encoder = Encoder::new(File::create(&icon_path).expect("创建 icons/icon.png 失败"), 1, 1);
        encoder.set_color(ColorType::Rgba);
        encoder.set_depth(BitDepth::Eight);
        let mut writer = encoder.write_header().expect("写入 PNG 头部失败");
        writer
            .write_image_data(&[0x00, 0xff, 0xff, 0xff])
            .expect("写入 PNG 像素数据失败");
    }
    tauri_build::build()
}
