# Hướng Dẫn Triển Khai PulseRadar Server Trên Nền Tảng Render (Web Service)

Tài liệu này hướng dẫn chi tiết quy trình cập nhật và chuyển đổi dịch vụ Render hiện tại (`simple-web-starter-3755`) sang Web Service hoàn chỉnh cho hệ thống giám sát đa nền tảng **PulseRadar Server**.

---

## 1. Tổng Quan Kiến Trúc & Lý Do Chuyển Đổi Dịch Vụ

- **Dịch vụ hiện tại:** `simple-web-starter-3755` (`srv-dbtteu8u01pc73d2ed60`)
- **Loại dịch vụ cũ:** **Static Site** (Chỉ phục vụ file tĩnh qua CDN, không có tiến trình Node.js, không chạy được API hoặc tác vụ nền).
- **Yêu cầu của PulseRadar Server:** 
  - Khởi chạy máy chủ Node.js Express (`tsx server.ts`).
  - Lắng nghe cổng động qua biến môi trường `PORT` trên `0.0.0.0`.
  - Phục vụ đồng thời REST API (`/api/health`, `/api/android/*`, `/api/workspace-state`, `/api/scan`) và giao diện frontend React 19 / Vite SPA (`dist/`).
  - Vận hành vòng lặp tự động quét livestream 30 giây/lần (`autoScanner.ts`).
  - Kết nối trực tiếp cơ sở dữ liệu serverless Neon PostgreSQL tại Singapore (`ap-southeast-1`).
- **Quy tắc nền tảng Render:** Render không hỗ trợ chuyển đổi trực tiếp kiểu dịch vụ từ *Static Site* sang *Web Service* trong cùng một tài nguyên. Do đó, cần khởi tạo **Web Service** mới hoặc thay thế dịch vụ cũ theo quy trình bên dưới để bảo toàn tên miền công khai `https://simple-web-starter-3755.onrender.com/`.

---

## 2. Thông Tin Cấu Hình & Biến Môi Trường (Environment Variables)

### 2.1 Thông Số Kỹ Thuật Render Web Service
| Mục | Giá Trị Cấu Hình |
| :--- | :--- |
| **Service Type** | `Web Service` |
| **Service Name** | `simple-web-starter-3755` |
| **Environment / Runtime** | `Node` |
| **Region** | `Singapore (Southeast Asia)` |
| **Branch** | `main` |
| **Build Command** | `npm install --legacy-peer-deps && npm run build` |
| **Start Command** | `npm start` |
| **Health Check Path** | `/api/health` |
| **Auto-Deploy** | `Yes` (tự động kích hoạt khi có commit mới) |

### 2.2 Danh Sách Biến Môi Trường Cần Thiết
Các biến sau đã được đóng gói sẵn trong `render.yaml` và `PulseRadar_Server/.env.production`:

1. `NODE_ENV` = `production`
2. `PORT` = `10000` (Render tự động gán cổng)
3. `AUTO_SCAN_ENABLED` = `true` (Kích hoạt vòng lặp quét streamer tự động khi khởi động)
4. `NPM_CONFIG_LEGACY_PEER_DEPS` = `true` (Tránh xung đột peer-dependency khi npm install trên đám mây)
5. `GEMINI_API_KEY` = `YOUR_GEMINI_API_KEY`
6. `DATABASE_URL` = `postgresql://neondb_owner:YOUR_NEON_PASSWORD@ep-winter-river-a1hipqli-pooler.ap-southeast-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require`
7. **Environment Group liên kết:** `neon-database` (Đã cấu hình sẵn trong tài khoản Render).

---

## 3. Quy Trình Triển Khai Chi Tiết (3 Cách Lựa Chọn)

### Cách 1: Triển Khai Bằng Render Blueprint (Khuyên Dùng)
File blueprint `render.yaml` đã được thiết lập chuẩn theo quy cách của Render:
1. Đẩy mã nguồn đã commit lên kho Git cá nhân (GitHub/GitLab) từ thư mục `D:\Deloy\PulseRadar_Server` hoặc giải nén tệp `PulseRadar_Render_Deploy_Ready.zip`.
2. Truy cập bảng điều khiển Render: [https://dashboard.render.com/blueprints](https://dashboard.render.com/blueprints).
3. Bấm **New Blueprint Instance** và chọn kho Git chứa `render.yaml`.
4. Render sẽ tự động phát hiện cấu hình `Web Service`, gắn Environment Group `neon-database` và tiến hành build.

### Cách 2: Tạo Trực Tiếp Web Service Trên Render Dashboard
1. Nếu muốn giữ nguyên slug `simple-web-starter-3755` và URL `https://simple-web-starter-3755.onrender.com/`:
   - Truy cập trang quản trị dịch vụ cũ: [https://dashboard.render.com/static/srv-dbtteu8u01pc73d2ed60/settings](https://dashboard.render.com/static/srv-dbtteu8u01pc73d2ed60/settings).
   - Đổi tên (Rename) hoặc Xóa (Delete) Static Site cũ để giải phóng tên miền `simple-web-starter-3755`.
2. Tạo Web Service mới:
   - Truy cập: [https://dashboard.render.com/select-repo?type=web](https://dashboard.render.com/select-repo?type=web).
   - Kết nối repository Git đã chứa mã nguồn `PulseRadar_Server`.
   - Đặt tên: `simple-web-starter-3755`.
   - Chọn **Region**: `Singapore`.
   - Chọn **Runtime**: `Node`.
   - Điền **Build Command**: `npm install --legacy-peer-deps && npm run build`.
   - Điền **Start Command**: `npm start`.
   - Mục **Environment Variables**: Thêm nhóm `neon-database` và các biến ở Mục 2.2.
   - Bấm **Create Web Service**.

### Cách 3: Kích Hoạt Qua Deploy Hook / Script Tự Động
Khi bạn đã có Deploy Hook URL từ Render:
Chạy script PowerShell đã tạo sẵn tại thư mục gốc:
```powershell
.\trigger_render_deploy.ps1 -DeployHookUrl "https://api.render.com/deploy/srv-dbtteu8u01pc73d2ed60?key=YOUR_DEPLOY_KEY"
```
Script sẽ tự động:
1. Kiểm tra trạng thái máy chủ hiện tại.
2. Gửi tín hiệu kích hoạt triển khai tới Render.
3. Theo dõi liên tục endpoint `/api/health` cho đến khi máy chủ phản hồi trạng thái sẵn sàng (`ok: true`).

---

## 4. Kiểm Tra & Xác Nhận Sau Triển Khai (Verification)

Sau khi Render hoàn tất quy trình Build và hiển thị trạng thái `Deploy Succeeded`:

1. **Kiểm tra Giao Diện Web (React 19 SPA):**
   - Truy cập: `https://simple-web-starter-3755.onrender.com/`
   - Tiêu đề trang web sẽ hiển thị **PulseRadar** (thay thế trang mẫu static cũ).
   - Giao diện quản lý quy tắc (44 kênh livestream định cấu hình sẵn) và bảng điều khiển trực quan sẽ hiển thị đầy đủ.

2. **Kiểm tra Health Endpoint (`GET /api/health`):**
   ```powershell
   Invoke-RestMethod -Uri "https://simple-web-starter-3755.onrender.com/api/health"
   ```
   **Phản hồi tiêu chuẩn (HTTP 200 OK):**
   ```json
   {
     "ok": true,
     "port": 10000,
     "autoScanEnabled": true,
     "autoScanRunning": true,
     "serverTime": "2026-11-19T04:xx:xx.xxxZ"
   }
   ```

3. **Kiểm tra Đồng Bộ Quy Tắc Workspace (`GET /api/workspace-state`):**
   ```powershell
   $state = Invoke-RestMethod -Uri "https://simple-web-starter-3755.onrender.com/api/workspace-state"
   Write-Host "So luong rule da tai:" $state.rules.Count
   ```
   **Kết quả:** Trả về đủ 4 rule gốc với 44 streamer handle trên TikTok, Instagram, X và Facebook.

4. **Kiểm tra Đăng Ký Thiết Bị Android (`POST /api/android/register`):**
   Ứng dụng `StreamRecorder_debug.apk` trên điện thoại Android có thể kết nối và đăng ký IP nội bộ / DDNS tới Render để tự động nhận lệnh ghi hình livestream.

---

## 5. Danh Mục Tệp Triển Khai Đã Đóng Gói

1. `D:\Deloy\PulseRadar_Server\render.yaml`: Blueprint khai báo hạ tầng cho Render Web Service.
2. `D:\Deloy\PulseRadar_Server\.npmrc`: Khai báo `legacy-peer-deps=true` đảm bảo build tự động thành công.
3. `D:\Deloy\PulseRadar_Server\.gitignore`: Loại trừ file bảo mật và ephemeral state, bảo toàn `workspace-state.json`.
4. `D:\Deloy\PulseRadar_Server\.env.production`: File mẫu cấu hình production hoàn chỉnh.
5. `D:\Deloy\PulseRadar_Server\.git`: Kho Git cục bộ đã commit phiên bản production sạch (`main` branch).
6. `D:\Deloy\PulseRadar_Render_Deploy_Ready.zip`: Gói nén source code sẵn sàng tải lên hoặc đẩy vào Git remote.
7. `D:\Deloy\trigger_render_deploy.ps1`: Script PowerShell hỗ trợ deploy webhook và giám sát sức khỏe dịch vụ.
