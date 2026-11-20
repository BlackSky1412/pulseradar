# HƯỚNG DẪN HỆ THỐNG PULSERADAR CLOUD (RENDER & NEON) & STREAMRECORDER (ANDROID)

## 1. Giới thiệu tổng quan & Kiến trúc mới nhất
Hệ thống kết hợp giữa **PulseRadar Cloud Server (Node.js/React trên Render + Neon PostgreSQL)** và **StreamRecorder App (Android Kotlin trên điện thoại)**:
- **Server Cloud quét tự động (Auto-Scan)**: Quét liên tục danh sách các kênh (TikTok, Instagram, Facebook, X) trên Cloud. Chạy hoàn toàn không cần cookie đối với các kênh công khai; chỉ sử dụng cookie khi người dùng cung cấp hoặc cần thiết.
- **Kéo lệnh chủ động thời gian thực (Active Client Polling mỗi 3 giây)**:
  - Khắc phục hoàn toàn bài toán chặn NAT mạng di động 4G/5G: Thay vì Server gửi request ngược vào điện thoại (dễ bị tường lửa mạng chặn), điện thoại Android tự chủ động gửi request đi (`POST /api/android/poll`) mỗi 3 giây.
  - Ngay khi Server quét thấy kênh phát Live, lệnh ghi hình lập tức được chuyển cho điện thoại trong vòng chưa đầy 3 giây để kích hoạt quay video ngay tức thì.
  - Tải siêu nhẹ (vài chục bytes/lần), không tốn pin, không cần bất kỳ công cụ đường hầm hay phần mềm phụ trợ nào.
- **Tự động tải Media chất lượng cao về Google Drive**: Khi phát hiện Post mới hoặc Story mới, hệ thống tự động bóc tách URL độ nét cao nhất (không watermark, HD video/ảnh gốc) và tải trực tiếp vào thư mục Google Drive:
  `G:\My Drive\PulseRadar_StreamRecorder_Package\Downloaded_Media\<username>\<posts|stories>\<timestamp>_<id>.<ext>`
- **Gửi thông báo tức thì về điện thoại**:
  - Khi có Post/Story mới tải về: Server gửi thông báo (`POST /notify`) và lưu vào hàng đợi đồng bộ (`pendingNotifications`).
  - Trên điện thoại: Tự động hiển thị Native System Notification (thanh trạng thái Android) báo cho người dùng biết nội dung và tên file vừa tải.
- **Tự động phát hiện đổi IP / Đổi mạng**:
  - Khi điện thoại chuyển giữa Wi-Fi ↔ 4G hoặc đổi địa chỉ IP, `NetworkMonitor` phát hiện sự kiện và tự động gửi đăng ký IP mới về Cloud Server (`POST /api/android/register`).
- **Đồng bộ tự động mỗi 10 phút (10-Minute Periodic Sync)**:
  - Cứ mỗi 10 phút, app Android tự động gửi `POST /api/android/sync` về Server để đối chiếu trạng thái ghi hình, cập nhật danh sách kênh theo dõi và nhận toàn bộ thông báo mới nhất.
- **Bảo mật truy cập Server (Device Whitelist / Giới hạn thiết bị)**:
  - Hỗ trợ giới hạn thiết bị được phép kết nối qua Device ID / Whitelist (`allowedDeviceIds`). Chỉ những thiết bị có trong danh sách được phép đăng ký và nhận lệnh.
  - Quản lý qua API: `GET /api/security/device-whitelist` và `PUT /api/security/device-whitelist`.

---

## 2. Thông tin Môi trường Cloud đang hoạt động

| Mục | Thông tin |
|---|---|
| **Render Cloud URL** | `https://pulseradar-server.onrender.com` |
| **API Health Check** | `https://pulseradar-server.onrender.com/api/health` |
| **Neon PostgreSQL** | `ep-winter-river-a1hipqli-pooler.ap-southeast-1.aws.neon.tech:5432` |
| **Thư mục Media Drive** | `G:\My Drive\PulseRadar_StreamRecorder_Package\Downloaded_Media` |
| **File cài đặt APK** | `G:\My Drive\PulseRadar_StreamRecorder_Package\StreamRecorder_debug.apk` |

---

## 3. Cấu hình trên Điện thoại Android

1. **Cài đặt APK**:
   - Tải file `StreamRecorder_debug.apk` từ thư mục Google Drive vào điện thoại và tiến hành cài đặt.
2. **Nhập URL Server trên App**:
   - Mở ứng dụng **StreamRecorder**.
   - Vào mục **Cài đặt (Settings)**.
   - Tại ô **PulseRadar URL**, nhập:
     ```text
     https://pulseradar-server.onrender.com
     ```
   - Nhấn **Lưu** hoặc **Đồng bộ ngay**.
3. **Kích hoạt Dịch vụ giám sát (Foreground Service)**:
   - Nhấn nút **Play / Bật giám sát** trên màn hình chính.
   - Trạng thái hiển thị: `PASSIVE LISTENER (:8765)` và `SYNC: OK`.
   - Toàn bộ tác vụ quét Live/Post/Story ngốn pin đã được chuyển lên Cloud; điện thoại chỉ chạy dịch vụ nhận thông báo và ghi hình thụ động khi có lệnh từ Cloud.

---

## 4. Các API chính của PulseRadar Cloud

| Endpoint | Method | Chức năng |
|---|---|---|
| `/api/health` | `GET` | Kiểm tra tình trạng server, số kênh theo dõi, thiết bị Android |
| `/api/android/register` | `POST` | Tiếp nhận đăng ký IP từ điện thoại (kiểm tra Device Whitelist) |
| `/api/android/poll` | `POST / GET` | Điện thoại chủ động kéo lệnh ghi hình Live và thông báo mới (chu kỳ 3s) |
| `/api/android/sync` | `POST` | Đối chiếu trạng thái và chuyển giao thông báo media mỗi 10 phút |
| `/api/android/status` | `GET` | Xem thông tin thiết bị Android, IP hiện tại và lịch sử đồng bộ |
| `/api/android/notify` | `POST` | Phát thông báo chủ động tới điện thoại |
| `/api/media/downloaded` | `GET` | Danh sách toàn bộ media Post/Story đã tự động tải về |
| `/api/media/file/:u/:t/:f` | `GET` | Tải hoặc stream trực tiếp file media từ server |
| `/api/security/device-whitelist` | `GET/PUT` | Quản lý danh sách Device ID được phép truy cập server |

---

## 5. Kết quả kiểm thử & Xác thực chất lượng

- **npm test**: 28/28 tests PASS (Firestore rules, live checkers, multi-platform, android integration).
- **watcher unit tests**: 18/18 tests PASS (TikTok live, post, story collectors, backoff, fault isolation).
- **E2E Access Control & Media Downloader**: 7/7 tests PASS (Device whitelist, notify queue, atomic Drive download).
- **Production Probe**: 5/5 PASS (DNS, Cloudflare Edge HTTPS 200 OK, Nosniff, HSTS, Dynamic API Health, Neon PostgreSQL Port 5432).
- **Android App Unit Tests**: `testDebugUnitTest` 25/25 tasks SUCCESSFUL.

