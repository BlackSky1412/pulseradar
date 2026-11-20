# TỔNG QUAN QUY TRÌNH & HỒ SƠ TRIỂN KHAI PULSERADAR LÊN RENDER
*Hệ thống giám sát Livestream PulseRadar Server & Android Companion App*
*Thời gian lập hồ sơ: Tháng 11/2026*

---

## 1. THÔNG TIN TÀI KHOẢN & DỊCH VỤ ĐÃ LIÊN KẾT

* **Tài khoản Render:** Mạnh Trần Công (`trancongmanh.it@gmail.com`)
* **Workspace Render:** `Mạnh's workspace` (ID: `tea-dbtt8vt6e07s73b5k34g`)
* **Render API Key:** `rnd_YOUR_RENDER_API_KEY` (Tên key: `pulseradar-key`)
* **Cơ sở dữ liệu Neon PostgreSQL:** 
  * Khu vực: AWS Asia Pacific (Singapore) - `ap-southeast-1` (độ trễ 41ms)
  * Nhóm môi trường Render: `neon-database` (chứa biến `DATABASE_URL`)
  * Chuỗi kết nối Pooled:
    `postgresql://neondb_owner:YOUR_NEON_PASSWORD@ep-winter-river-a1hipqli-pooler.ap-southeast-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require`
* **Dịch vụ đang hoạt động trên Render:** `pulseradar-server` (ID: `srv-dbvfo8l9el5s73bokv1g`, URL: `https://pulseradar-server.onrender.com/`)
* **Kiến trúc kích hoạt Live:** **Active Client Polling** (Điện thoại tự chủ động kéo lệnh mỗi 3 giây, loại bỏ 100% rào cản chặn NAT 4G/Wi-Fi, không cần Termux/Cloudflare Tunnel)
* **Giao diện Web:** Tích hợp **UserAvatar** nhận diện đa nền tảng, huy hiệu platform, vòng sáng phát sóng Live đỏ nhấp nháy và thanh nổi bật Kênh Đang Live.

---

## 2. DANH MỤC TÀI LIỆU VÀ TỆP TIN TRONG GÓI NÀY

| STT | Tên tài liệu / Tệp | Nội dung chi tiết |
| :---: | :--- | :--- |
| **00** | `00_TONG_QUAN_QUY_TRINH_TRIEN_KHAI.md` | Tài liệu tóm tắt này. |
| **01** | `01_Bao_Cao_Trien_Khai_Chi_Tiet.md` | Báo cáo kiểm toán, hạ tầng mạng Cloudflare Anycast CDN, phân tích kỹ thuật 330+ dòng. |
| **02** | `02_Huong_Dan_Kich_Hoat_Render_Web_Service.md` | Sổ tay hướng dẫn chi tiết từng bước bấm chuột tạo Web Service trên Render Dashboard. |
| **03** | `03_Huong_Dan_Dong_Bo_Android_PulseRadar.md` | Hướng dẫn cài đặt file APK trên điện thoại, cấu hình Background Service và đồng bộ lệnh ghi hình. |
| **04** | `04_render.yaml` | Tệp bản thiết kế Blueprint chuẩn cho Render Web Service Node.js v20+ và kết nối Neon DB. |
| **05** | `05_trigger_render_deploy.ps1` | Kịch bản PowerShell tự động kích hoạt deploy qua Deploy Hook và kiểm tra Health Check `/api/health`. |
| **06** | `PulseRadar_Render_Deploy_Ready.zip` | Toàn bộ mã nguồn sạch của PulseRadar Server (đã tích hợp động cơ TikTok Watcher Handoff: Auto Tracking Live/Post/Story độc lập, UI phân tách TikTok/Instagram/Facebook/X, bộ lọc trùng lặp & warmup, 44 kênh cấu hình và bản build `dist/`). |

---

## 2.1. CẬP NHẬT TÍNH NĂNG MỚI (TIKTOK WATCHER & MULTI-PLATFORM UI)
* **Động cơ TikTok Watcher (`server/watchers/`)**:
  * Tích hợp theo chuẩn tài liệu bàn giao `Tiktok Watcher Handoff.md`.
  * Bộ thu thập (Collectors) độc lập: `tiktokLive.ts`, `tiktokPost.ts`, `tiktokStory.ts`.
  * Bộ lưu trữ trạng thái `stateStore.ts` với cơ chế chống trùng lặp (Deduplication) và khởi tạo thông minh (Warmup run đầu không spam thông báo).
  * Hệ thống thông báo đa kênh `notifier.ts` (Webhook / Discord / Telegram).
  * API backend: `GET /api/watcher/status`, cấu hình tự động trong `PUT /api/workspace-state`.
* **Giao diện người dùng phân tách từng nền tảng**:
  * Chia tab rõ ràng cho từng mạng xã hội: **TikTok**, **Instagram**, **Facebook**, **X (Twitter)**.
  * Mỗi nền tảng có bộ điều khiển Auto Tracking riêng biệt cho **Live**, **Post**, và **Story**.
  * Hỗ trợ điều hướng liên kết tĩnh (Deep-linking URL Hash: `#tiktok`, `#instagram`, `#facebook`, `#twitter`).
* **Đảm bảo chất lượng**:
  * Đạt 100% kiểm thử tự động (28/28 frontend/backend tests, 18/18 watcher engine tests).
  * `tsc --noEmit` & `vite build` thành công tuyệt đối không lỗi.

---

## 3. HƯỚNG DẪN 2 BƯỚC HOÀN TẤT TRÊN RENDER DASHBOARD

Màn hình Render hiện tại của bạn đang mở sẵn tại:
👉 https://dashboard.render.com/select-repo?type=web

1. **Bước 1 (Chọn Git):**
   * Bấm **Connect account** tại mục **GitHub** (hoặc dán link Git công khai vào ô **Public Git Repository**) ➔ Bấm **Continue**.
2. **Bước 2 (Điền cấu hình):**
   * **Name:** `pulseradar-server` (hoặc `simple-web-starter-3755`)
   * **Region:** `Singapore`
   * **Runtime:** `Node`
   * **Build Command:** `npm install --legacy-peer-deps && npm run build`
   * **Start Command:** `npm start`
   * **Health Check Path:** `/api/health`
   * **Environment Variables:** Liên kết nhóm `neon-database`, thêm `NODE_ENV=production`, `AUTO_SCAN_ENABLED=true`, `GEMINI_API_KEY=YOUR_GEMINI_API_KEY`.
3. Bấm **Create Web Service** để Render tự động build và chạy trực tiếp.
