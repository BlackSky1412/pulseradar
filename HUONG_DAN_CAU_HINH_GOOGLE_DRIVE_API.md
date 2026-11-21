# HƯỚNG DẪN CẤU HÌNH GOOGLE DRIVE API CHO RENDER (PULSERADAR)
*Tự động đẩy bài Post & Story từ Cloud Render về Google Drive cá nhân*

---

## 1. NGUYÊN LÝ HOẠT ĐỘNG
* Khi phát hiện bài Post hoặc Story mới, máy chủ Render tải video/ảnh chất lượng gốc về.
* Thông qua **Google Drive API v3 (Service Account)**, máy chủ sẽ tự động tải file lên thư mục Google Drive bạn đã chỉ định.
* Bạn và chú có thể mở Google Drive trên điện thoại, máy tính là thấy ngay file được sắp xếp ngăn nắp theo cấu trúc:
  ```text
  [Thư mục Drive của bạn]
  └── <tên_người_dùng>/
      ├── posts/
      │   └── 20261121_id12345.mp4
      └── stories/
          └── 20261121_id67890.jpg
  ```

---

## 2. QUY TRÌNH CẤU HÌNH 3 BƯỚC

### BƯỚC 1: TẠO SERVICE ACCOUNT & KHÓA JSON TRÊN GOOGLE CLOUD
1. Truy cập **[Google Cloud Console](https://console.cloud.google.com/)** (đăng nhập cùng tài khoản Google của bạn hoặc dùng chung Project Firebase của PulseRadar).
2. Vào **APIs & Services** ➔ **Library** (Thư viện) ➔ Tìm kiếm **Google Drive API** ➔ Bấm **Enable** (Bật).
3. Vào **IAM & Admin** ➔ **Service Accounts** ➔ Bấm **Create Service Account**:
   * **Service account name:** `pulseradar-drive-uploader`
   * Bấm **Create and Continue** ➔ Bấm **Done**.
4. Bấm vào Service Account vừa tạo ➔ Chuyển qua tab **Keys** (Khóa) ➔ Chọn **Add Key** ➔ **Create new key** ➔ Chọn kiểu **JSON** ➔ Bấm **Create**.
5. Một file `.json` sẽ tự động tải về máy tính của bạn (đây là file khóa chứa `client_email` và `private_key`).
6. Mở file JSON vừa tải về, copy địa chỉ email của robot (dạng: `pulseradar-drive-uploader@<ten-project>.iam.gserviceaccount.com`).

---

### BƯỚC 2: TẠO THƯ MỤC TRÊN GOOGLE DRIVE & CHIA SẺ QUYỀN
1. Mở **[Google Drive cá nhân của bạn](https://drive.google.com/)**.
2. Tạo một thư mục mới, ví dụ đặt tên là: `PulseRadar_Media`.
3. Nhấp chuột phải vào thư mục `PulseRadar_Media` ➔ Chọn **Share (Chia sẻ)**:
   * Dán địa chỉ email robot bạn vừa copy ở Bước 1 vào ô người nhận.
   * Chọn quyền: **Editor (Người chỉnh sửa)**.
   * Bỏ tích "Notify people" (Thông báo cho mọi người) ➔ Bấm **Send (Gửi)** hoặc **Share (Chia sẻ)**.
4. Mở thư mục `PulseRadar_Media` ra, nhìn lên thanh địa chỉ trình duyệt URL:
   * URL có dạng: `https://drive.google.com/drive/folders/1aBcDeFgHiJkLmNoPqRsTuVwXyZ`
   * Đoạn mã phía sau `folders/` chính là **Folder ID** (ví dụ: `1aBcDeFgHiJkLmNoPqRsTuVwXyZ`). Hãy copy đoạn mã này.

---

### BƯỚC 3: DÁN BIẾN MÔI TRƯỜNG LÊN RENDER DASHBOARD
1. Truy cập: **[https://dashboard.render.com/web/srv-dbvfo8l9el5s73bokv1g/env](https://dashboard.render.com/web/srv-dbvfo8l9el5s73bokv1g/env)**.
2. Thêm 2 biến môi trường mới:
   * **Tên biến 1:** `GDRIVE_SERVICE_ACCOUNT_KEY`  
     **Giá trị:** Mở file JSON ở Bước 1 bằng Notepad, copy toàn bộ nội dung file và dán vào ô giá trị này.
   * **Tên biến 2:** `GDRIVE_FOLDER_ID`  
     **Giá trị:** Dán đoạn mã **Folder ID** bạn đã copy ở Bước 2.
3. Bấm **Save Changes** để Render lưu và tự động cập nhật.

---

## 3. KIỂM TRA KẾT QUẢ KẾT NỐI
Sau khi lưu, mở giao diện PulseRadar tại:
👉 **[https://pulseradar-server.onrender.com/#activity](https://pulseradar-server.onrender.com/#activity)**
Tại mục **Lưu Trữ Đám Mây (Cloud Storage)**, bạn sẽ thấy huy hiệu Google Drive chuyển sang:  
🟢 **Đã kết nối API (`pulseradar-drive-uploader`)**
Từ thời điểm này, mọi bài Post và Story mới phát hiện sẽ được tự động đồng bộ vào Google Drive!
