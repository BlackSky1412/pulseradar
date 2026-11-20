# HƯỚNG DẪN HỆ THỐNG ĐỒNG BỘ PULSERADAR (SERVER) & STREAMRECORDER (ANDROID)

## 1. Giới thiệu tổng quan
Hệ thống kết hợp giữa **PulseRadar Server (Node.js/React trên PC)** và **StreamRecorder App (Android Kotlin trên điện thoại)** nhằm tối ưu hóa việc theo dõi và ghi hình livestream tự động:
- **Server quét tự động (Auto-Scan)**: Quét liên tục danh sách các kênh (TikTok, Instagram, Facebook, X) theo chu kỳ định cấu hình (mặc định 30 giây). Khi phát hiện user lên Live, Server chủ động phát lệnh `POST /record` tới điện thoại.
- **Android thụ động (Passive Mode)**: Điện thoại tắt toàn bộ việc tự quét API mạng xã hội để tiết kiệm pin và tránh checkpoint/bị khóa tài khoản mạng xã hội. Thay vào đó, app mở một HTTP server nội bộ tại cổng `:8765` để chờ lệnh từ Server.
- **Dynamic IP Registration**: Điện thoại tự động phát hiện khi đổi mạng Wi-Fi và cập nhật IP của mình về Server (`POST /api/android/register`).
- **Đối chiếu định kỳ 10 phút (Server-Authoritative Sync)**: Cứ mỗi 10 phút, app Android gửi danh sách kênh và trạng thái hiện tại về Server (`POST /api/android/sync`). Server giữ vai trò chuẩn (Source of Truth), đối chiếu và yêu cầu điện thoại cập nhật danh sách kênh cũng như kích hoạt ghi hình nếu có kênh đang Live mà app chưa ghi.

---

## 2. Cấu trúc thư mục gói đóng gói
```text
PulseRadar_StreamRecorder_Sync/
├── APK/
│   └── StreamRecorder_debug.apk        # File cài đặt ứng dụng Android mới nhất
├── PulseRadar_Server/                  # Toàn bộ mã nguồn Server & Web UI
│   ├── server/                         # Module autoScanner, androidClient, reconcile, stateStore
│   ├── src/                            # Giao diện React/Vite Dashboard
│   ├── data/                           # Dữ liệu workspace & trạng thái đồng bộ
│   ├── tests/                          # Bộ test E2E (156 tests)
│   ├── server.ts                       # Điểm khởi chạy server chính
│   └── package.json
├── StreamRecorder_Android/             # Toàn bộ mã nguồn Android (Android Studio / Gradle)
│   ├── app/src/main/java/              # Mã nguồn Kotlin (Service, HTTP receiver, UI)
│   ├── build.gradle.kts
│   └── build_apk.bat
└── HUONG_DAN_SU_DUNG.md                # Tài liệu hướng dẫn này
```

---

## 3. Hướng dẫn cài đặt & Khởi chạy

### A. Phía Android (Điện thoại)
1. **Cài đặt APK**:
   - Tải file `StreamRecorder_debug.apk` trong thư mục `APK/` vào điện thoại và tiến hành cài đặt.
   - Hoặc cài đặt trực tiếp từ máy tính qua ADB:
     ```bash
     adb install -r APK/StreamRecorder_debug.apk
     ```
2. **Khởi chạy Service**:
   - Mở ứng dụng `StreamRecorder`.
   - Vào Cài đặt để kiểm tra địa chỉ Server PulseRadar (mặc định: `http://192.168.1.10:3000`).
   - Bật dịch vụ giám sát (Foreground Service). Trên thanh thông báo sẽ hiển thị:
     `Stream Recorder (Passive) - Lắng nghe lệnh từ PulseRadar cổng :8765`.

### B. Phía Máy tính (PulseRadar Server)
1. **Yêu cầu môi trường**:
   - Node.js >= 18.
2. **Cài đặt thư viện**:
   ```bash
   cd PulseRadar_Server
   npm install
   ```
3. **Khởi chạy Server**:
   ```bash
   npm run dev
   ```
   Server sẽ lắng nghe tại `http://0.0.0.0:3000` (truy cập trình duyệt: `http://localhost:3000` hoặc IP LAN `http://192.168.1.10:3000`).
4. **Kiểm tra trạng thái kết nối với Android**:
   - Mở trình duyệt hoặc dùng curl/PowerShell:
     ```powershell
     Invoke-RestMethod -Uri "http://localhost:3000/api/android/status"
     ```
   - Kết quả trả về sẽ hiển thị thông tin thiết bị Android đang kết nối (`ip: 192.168.1.9`, `port: 8765`, `lastSyncAt`).

---

## 4. Các cổng & API tương tác chính

| Thiết bị | Cổng / Endpoint | Mô tả |
|---|---|---|
| **Server** (PC) | `:3000` | Giao diện điều khiển Web UI PulseRadar |
| **Server** (PC) | `POST /api/android/register` | Endpoint tiếp nhận đăng ký IP từ điện thoại |
| **Server** (PC) | `POST /api/android/sync` | Endpoint tiếp nhận đối chiếu dữ liệu mỗi 10 phút |
| **Server** (PC) | `GET /api/android/status` | Xem tình trạng thiết bị Android và bộ quét Live |
| **Android** | `:8765/health` | Kiểm tra trạng thái hoạt động của receiver trên điện thoại |
| **Android** | `:8765/record` | Endpoint nhận lệnh ghi hình trực tiếp từ Server |

---

## 5. Chạy kiểm thử tự động (Verification)
Trong thư mục `PulseRadar_Server`:
- **Chạy toàn bộ 156 ca kiểm thử E2E (Tiers 1-4 & Invariants)**:
  ```bash
  node --import tsx tests/e2e/run.ts
  ```
- **Chạy kiểm tra tự động trên thiết bị thật đang kết nối ADB**:
  ```powershell
  powershell -ExecutionPolicy Bypass -File tests/e2e/verify-android-device.ps1
  ```
