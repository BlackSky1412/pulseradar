# HƯỚNG DẪN CẤU HÌNH NHÁNH TELEGRAM BOT (PULSERADAR)
*Nhánh lưu trữ & nhận thông báo bài Post / Story qua Kênh Telegram riêng tư*

---

## 1. NGUYÊN LÝ HOẠT ĐỘNG
* Khi phát hiện bài Post hoặc Story mới, hệ thống tự động tải media về.
* Nhánh Telegram sẽ sử dụng Bot API (`sendVideo` / `sendPhoto` / `sendDocument`) để đẩy trực tiếp file lên Kênh Telegram riêng tư của bạn và chú.
* Điện thoại nhận thông báo tít tít, xem video/ảnh chất lượng gốc ngay trong app Telegram, không giới hạn dung lượng lưu trữ đám mây.

---

## 2. QUY TRÌNH KÍCH HOẠT KHI BẠN CẦN DÙNG (CẤU HÌNH SAU)

Khi nào bạn và chú muốn kích hoạt nhánh Telegram, chỉ cần thực hiện 3 bước nhanh:

### BƯỚC 1: TẠO BOT TELEGRAM
1. Mở ứng dụng Telegram, tìm kiếm bot **`@BotFather`** (có tích xanh).
2. Gửi lệnh `/newbot`, đặt tên cho Bot (ví dụ: `PulseRadar Monitor Bot`) và username cho bot (ví dụ: `pulseradar_alert_bot`).
3. BotFather sẽ gửi cho bạn một chuỗi **HTTP API Token** có dạng:  
   `123456789:ABCdefGhIJKlmNoPQRsTUVwxyZ`  
   ➔ Đây chính là **`TELEGRAM_BOT_TOKEN`**.

---

### BƯỚC 2: TẠO KÊNH RIÊNG TƯ & LẤY CHAT ID
1. Trên Telegram, tạo một Kênh mới (**New Channel**) hoặc Nhóm (**New Group**), chọn chế độ **Private (Riêng tư)**.
2. Thêm Bot bạn vừa tạo ở Bước 1 vào kênh/nhóm với quyền **Administrator (Quản trị viên)**.
3. Thêm tài khoản Telegram của chú và bạn vào kênh.
4. Lấy Chat ID của kênh:
   * Chuyển tiếp (Forward) 1 tin nhắn bất kỳ từ kênh đó sang bot `@userinfobot` hoặc `@JsonDumpBot`.
   * Bot sẽ trả về ID của kênh (dạng số âm, ví dụ: `-1001234567890`).
   * ➔ Đây chính là **`TELEGRAM_CHAT_ID`**.

---

### BƯỚC 3: KÍCH HOẠT TRÊN RENDER DASHBOARD
1. Truy cập: **[https://dashboard.render.com/web/srv-dbvfo8l9el5s73bokv1g/env](https://dashboard.render.com/web/srv-dbvfo8l9el5s73bokv1g/env)**.
2. Thêm 2 biến môi trường:
   * `TELEGRAM_BOT_TOKEN`: Dán token từ BotFather.
   * `TELEGRAM_CHAT_ID`: Dán Chat ID của kênh.
3. Bấm **Save Changes**.
4. Máy chủ Render sẽ tự động kích hoạt tính năng gửi media sang Telegram mà không cần sửa đổi bất kỳ dòng mã nguồn nào!
