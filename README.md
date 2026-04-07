<div align="center">

# ⚡ API Worker

**Cursor AI network controller — proxy local, clean logs, full control.**

[![Version](https://img.shields.io/badge/version-1.0.5-blue?style=flat-square)](https://github.com/dichvuright/api-worker/releases)
[![Platform](https://img.shields.io/badge/platform-Cursor%20%7C%20VSCode-black?style=flat-square)](https://cursor.sh)
[![License](https://img.shields.io/badge/license-ISC-green?style=flat-square)](./LICENSE.md)

</div>

---

## 🚀 Tính năng

- **🔀 Proxy local** — Redirect Cursor AI requests về worker chạy trên máy
- **🔑 Quản lý API Key** — Thêm, xoá, ưu tiên nhiều key từ nhiều provider
- **🧹 Clean logs** — Filter noise log tự động, chỉ hiện thứ quan trọng
- **🔕 Silent endpoints** — Tự động trả 200 OK cho analytics, telemetry, network ping
- **⚙️ Control Panel** — UI trực tiếp trong sidebar Cursor để quản lý worker
- **🔄 Auto-update** — Worker tự check và cập nhật phiên bản mới
- **🛡️ MCP Support** — Tích hợp Model Context Protocol server

---

## 📦 Cài đặt

### Từ file VSIX (khuyến nghị)

1. Download file `.vsix` từ [Releases](https://github.com/dichvuright/api-worker/releases)
2. Mở Cursor → `Ctrl+Shift+P` → **Extensions: Install from VSIX...**
3. Chọn file `.vsix` vừa download
4. Reload Cursor

### Build từ source

```bash
git clone https://github.com/dichvuright/api-worker.git
cd api-worker
npm install
npm run package:vsix
```

File `.vsix` sẽ được tạo ở thư mục gốc.

---

## 🛠️ Development

```bash
# Build (copy src → dist)
npm run build

# Build + watch mode
npm run start

# Build + smoke test
npm run smoke

# Đóng gói thành .vsix
npm run package:vsix
```

> **Lưu ý:** Sau khi sửa code, chạy `npm run package:vsix` rồi cài lại VSIX vào Cursor.

---

## 📁 Cấu trúc project

```
├── src/
│   ├── extension.js      # Entry point, patch Cursor workbench
│   ├── shell.js          # Worker process manager + log filter
│   └── mcp-server.js     # MCP protocol server
├── scripts/
│   ├── build.mjs         # Build script (src → dist)
│   ├── package-vsix.mjs  # Đóng gói VSIX
│   └── run-editor.mjs    # Dev runner
├── webview/
│   └── pool.html         # Control panel UI
└── resources/
    ├── icon.jpg
    └── mainView-icon.svg
```

---

## ⚙️ Cách hoạt động

```
Cursor IDE
    │
    │  request đến api2.cursor.sh / api3.cursor.sh / api4.cursor.sh
    │
    ▼
vn.local.dichvuright.com:9182  (127.0.0.1 — local proxy)
    │
    ├── Silent endpoints (analytics, telemetry, ping) → 200 OK ngay
    │
    └── AI endpoints (StreamChat, StreamCompletion...) → forward upstream
```

DNS `vn.local.dichvuright.com` trỏ về `127.0.0.1` — worker lắng nghe trên port `9182`.

---

## 📋 Commands

Mở Command Palette (`Ctrl+Shift+P`):

| Command | Mô tả |
|---------|-------|
| `API Worker: Open API Config Panel` | Mở control panel |
| `API Worker: Start Local Worker` | Khởi động worker thủ công |
| `API Worker: Show Logs Panel` | Xem logs |

---

## 🔧 Troubleshooting

**Worker không start?**
```powershell
# Xoá cache worker và restart Cursor
Remove-Item "$env:TEMP\api-worker" -Force
Remove-Item "$env:TEMP\api-worker.hash" -Force
```

**Vẫn thấy log spam?**
- Đảm bảo đã cài đúng phiên bản VSIX mới nhất
- Reload Cursor sau khi cài

---

## 📄 License

ISC © [DichVuRight](https://dichvuright.com)
