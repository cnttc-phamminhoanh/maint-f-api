# mnt-api — API Quản lý Bảo dưỡng Thiết bị (standalone)

Bộ API viết bằng **JavaScript + Express**, kết nối trực tiếp **SQL Server** (dữ liệu bạn đã đồng bộ từ ứng dụng), dùng **Joi** kiểm tra toàn bộ dữ liệu đầu vào và **Swagger UI** làm dashboard tài liệu.

Tương thích hoàn toàn với frontend hiện tại: đường dẫn, phương thức HTTP, tên tham số và cấu trúc JSON được giữ nguyên như backend gốc.

## 1. Cài đặt & chạy

```bash
cd local-api
npm install
cp .env.example .env        # rồi sửa thông tin kết nối SQL Server
npm start                   # hoặc: npm run dev (tự khởi động lại khi sửa code)
```

- API: `http://localhost:3100`
- **Dashboard (Swagger UI): `http://localhost:3100/docs`** — danh sách toàn bộ endpoint, mô tả, tham số, bấm "Try it out" để gọi thử
- Spec JSON: `http://localhost:3100/docs.json`
- Health check: `http://localhost:3100/health`

### Cấu hình `.env`

| Biến | Ý nghĩa |
|---|---|
| `PORT` | Cổng HTTP (mặc định 3100) |
| `HOST` | Địa chỉ bind (mặc định `127.0.0.1` — chỉ reverse proxy gọi được) |
| `ALLOW_HTTP` | `false` (mặc định): chỉ nhận HTTPS khi công khai; đặt `true` khi chạy nội bộ/dev |
| `SESSION_TTL_DAYS` | Token phiên sống bao nhiêu ngày (mặc định 30) |
| `PIN_MAX_ATTEMPTS` / `PIN_LOCK_MINUTES` | Sai PIN/khuôn mặt bao nhiêu lần thì khóa, khóa bao nhiêu phút (5 / 15) |
| `REGISTER_MAX_ATTEMPTS` / `REGISTER_WINDOW_MINUTES` | Giới hạn thử mật khẩu đăng ký (10 lần / 15 phút) |
| `DB_SERVER` / `DB_PORT` / `DB_USER` / `DB_PASSWORD` / `DB_NAME` | Kết nối SQL Server |
| `DB_TRUST_SERVER_CERT` | `true` nếu SQL Server dùng chứng chỉ self-signed |
| `UPDATED_AT_COL` | Tên cột hệ thống cập nhật thời gian. **Mặc định rỗng (tắt)** vì bảng `eqm_mnt` tự tạo trong SQL Server thường không có cột `_updated_at`; chỉ đặt `UPDATED_AT_COL=_updated_at` nếu bảng của bạn thực sự có cột này |
| `REGISTER_PASSWORD` | Mật khẩu mở chức năng đăng ký (`POST /api/auth/register-access`) |
| `FACE_QUALITY_URL` | (Tùy chọn) URL dịch vụ kiểm tra chất lượng ảnh khuôn mặt |
| `FACE_COMPARE_URL` | (Tùy chọn) URL dịch vụ so sánh khuôn mặt — mong đợi `POST {imageUrl, registeredUrl}` trả về `{matched: boolean}` |

> Yêu cầu bảng trong SQL Server: tên bảng và tên cột trùng với dữ liệu đã đồng bộ (`emp_mnt`, `dept_mnt`, `eqm_mnt`, `eqm_mnt_delay`, `eqm_bas_mt`, `eqm_mt1`, `eqm_mt2`). Các cột hệ thống `_created_at/_updated_at/...` không bắt buộc — `UPDATED_AT_COL` mặc định đã rỗng (mọi truy vấn đã bọc sẵn để bỏ qua); đặt `UPDATED_AT_COL=_updated_at` nếu bảng của bạn có cột này để giữ thứ tự «vừa quét mã lên đầu» trong nhóm đang bảo dưỡng.

## 1b. Bảo mật (bắt buộc khi công khai ra internet)

### Chạy script SQL tạo bảng phiên & chống dò PIN

```sql
-- Chạy file sql/001_session_security.sql trên SQL Server của bạn (1 lần)
```

Tạo 2 bảng: `emp_mnt_session` (token phiên, chỉ lưu SHA-256 hash) và `emp_mnt_login_lock` (đếm lần đăng nhập sai).

### Luồng token phiên

1. Đăng nhập bằng **MNV (`empNo`)** + PIN hoặc khuôn mặt — nhân viên chỉ cần nhớ mã nhân viên, không cần biết id nội bộ. Thành công → server trả `token` + `expiresAt` + `userId` + `empNo` + `empName`
2. **Mọi request sau đó** phải mang header `Authorization: Bearer <token>` — thiếu/sai/hết hạn → `401 UNAUTHORIZED`
3. Trường `userId` trong body/query **do server tự ghi đè theo chủ phiên** — client truyền gì cũng không mạo danh được người khác
4. Các endpoint yêu cầu token mà nhận `empNo` (user/profile, pin/change, face/register...): truyền MNV không phải của chủ phiên → **`403 TOKEN_USER_MISMATCH`** (chặn ngay, không tự sửa)
4. `POST /api/auth/logout` thu hồi phiên; đổi PIN thu hồi toàn bộ phiên của tài khoản đó
5. Các route công khai (không cần token): `/user/lookup`, `/user/status`, `/user/register` (**vẫn công khai nhưng phải gửi đúng `accessPassword`** — server kiểm tra, chống đăng ký hàng loạt), `/pin/setup` (chỉ đặt được PIN khi chưa có), `/pin/verify`, `/face/verify`, `/register-access`

### Chặn dò PIN / khuôn mặt

Sai `PIN_MAX_ATTEMPTS` lần liên tiếp (PIN hoặc khuôn mặt) → tài khoản bị khóa `PIN_LOCK_MINUTES` phút, trả `429 ACCOUNT_LOCKED:<phút>`. Đăng nhập đúng sẽ xóa bộ đếm. Mật khẩu đăng ký cũng bị giới hạn `REGISTER_MAX_ATTEMPTS` lần / `REGISTER_WINDOW_MINUTES` phút.

### Bắt buộc HTTPS + reverse proxy

Khi công khai: chạy sau nginx có TLS, API bind `127.0.0.1` và từ chối mọi request không phải HTTPS (`426 HTTPS_REQUIRED`, trừ khi `ALLOW_HTTP=true`). Mẫu nginx:

```nginx
server {
    listen 443 ssl http2;
    server_name api.cua-ban.com;

    ssl_certificate     /etc/letsencrypt/live/api.cua-ban.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/api.cua-ban.com/privkey.pem;

    # Chan mo /docs ra ngoai (tuy chon, khuyen nghi)
    location /docs { deny all; }

    location / {
        proxy_pass http://127.0.0.1:3100;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
server {
    listen 80;
    server_name api.cua-ban.com;
    return 301 https://$host$request_uri;
}
```

> Lưu ý: camera quét khuôn mặt / QR của frontend chỉ hoạt động trên HTTPS — bắt buộc dùng domain + chứng chỉ (Let's Encrypt hoặc Cloudflare Tunnel), không dùng IP trần với http.

## 2. Danh sách endpoint (31)

### Auth — `/api/auth` (10)
| Phương thức | Đường dẫn | Chức năng |
|---|---|---|
| GET | `/user/lookup?empNo=` | Tra nhân viên theo MNV |
| GET | `/user/status?empNo=` | Trạng thái PIN / khuôn mặt |
| POST | `/user/register` | Đăng ký lần đầu theo MNV — **bắt buộc gửi `accessPassword`** (server kiểm tra, chống đăng ký hàng loạt) |
| POST | `/user/profile` | Đổi tên hiển thị / avatar (yêu cầu token) |
| POST | `/pin/setup` | Đặt PIN (băm scrypt) |
| POST | `/pin/verify` | Đăng nhập MNV + PIN — trả `token` |
| POST | `/pin/change` | Đổi PIN (yêu cầu token) |
| POST | `/logout` | Thu hồi token phiên (yêu cầu token) |
| POST | `/face/register` | Đăng ký khuôn mặt |
| POST | `/register-access` | Kiểm tra mật khẩu mở đăng ký (UI gate; `/user/register` cũng bắt buộc mật khẩu này ở server) |
| POST | `/face/verify` | Đăng nhập khuôn mặt |

### Devices — `/api/devices` (14)
| Phương thức | Đường dẫn | Chức năng |
|---|---|---|
| GET | `/` | Danh sách thiết bị (phân quyền, lọc status/due/cycle/search, phân trang) |
| GET | `/by-qr?qr=&userId=` | Tra theo mã QR — **chính xác tuyệt đối**, khác bộ phận → 403 |
| GET | `/managed?userId=` | Thiết bị do tôi quản lý (approver) |
| GET | `/factories?userId=` | Danh sách phân xưởng |
| GET | `/maintainer-candidates?userId=` | Ứng viên người phụ trách (cùng bộ phận) |
| GET | `/:id` | Chi tiết thiết bị |
| PATCH | `/:id/status` | Đổi trạng thái (tự ghi người bảo dưỡng tạm trong ngày) |
| POST | `/:id/submit-approval` | Gửi xét duyệt (kèm hạng mục đã chọn) |
| POST | `/:id/approve-completion` | Xác nhận → **lúc này mới tạo đơn bảo dưỡng** |
| POST | `/:id/reject-completion` | Từ chối kèm lý do |
| POST | `/bulk-approve-completion` | Xác nhận hàng loạt |
| POST | `/bulk-reject-completion` | Từ chối hàng loạt |
| POST | `/:id/undo-maintenance` | Hoàn tác (chỉ người đang bảo dưỡng / chủ quản / văn thư bộ phận) |
| POST | `/:id/transfer-factory` | Chuyển phân xưởng + người phụ trách mới |

### Maintenance Orders — `/api/maintenance-orders` (2)
| Phương thức | Đường dẫn | Chức năng |
|---|---|---|
| GET | `/templates?equType=&mtFlag=` | Hạng mục chuẩn theo loại thiết bị (mtFlag 1→wk1_sw, 2→wk2_sw, 3→mon_sw, 4→year_sw) |
| GET | `/device/:deviceId` | Đơn bảo dưỡng của thiết bị (kèm hạng mục từng đơn) |

### Delayed Devices — `/api/delayed-devices` (2, chỉ admin)
| Phương thức | Đường dẫn | Chức năng |
|---|---|---|
| GET | `/?userId=&reason=&page=&pageSize=` | Danh sách thiết bị trễ hạn |
| POST | `/sync` | Đồng bộ lại bảng trễ hạn |

### Statistics — `/api/statistics` (3, công khai)
| Phương thức | Đường dẫn | Chức năng |
|---|---|---|
| GET | `/overview` | Tổng quan BI |
| GET | `/delayed-devices` | Thiết bị trễ hạn cho trang BI |
| GET | `/equipment` | Danh sách thiết bị BI + danh mục lọc |

## 3. Kiểm tra dữ liệu đầu vào (Joi)

- Mọi endpoint có middleware Joi: sai kiểu / thiếu trường / enum sai → **HTTP 400** kèm thông báo chi tiết từng lỗi (`abortEarly: false`), trường lạ bị loại bỏ (`stripUnknown`).
- Quy tắc đáng chú ý: `pin` khi đặt/đổi ≥ 4 ký tự; `ids` trong bulk là mảng string không rỗng; `page ≥ 1`, `pageSize ≤ 100`; `status`/`due`/`cycle`/`reason` là enum; `userId` bắt buộc ở các endpoint nghiệp vụ.

## 4. Những điểm "chưa chuẩn" đã phát hiện khi chuyển đổi

Đây là các vấn đề tìm thấy trong logic hệ thống cũ và cách bộ API này xử lý:

1. **Tính hạn bảo dưỡng chu kỳ tháng bị lệch ngày cuối tháng** — cộng tháng kiểu JavaScript làm ngày 31 "tràn" sang tháng sau (31/01 + 1 tháng → 03/03), trong khi SQL `EOMONTH` kẹp về cuối tháng. Bộ API này thống nhất dùng cách kẹp (28/29/30/31 → cuối tháng đích). Nếu dữ liệu đã đồng bộ được tính theo kiểu tràn, hạn của một số thiết bị có thể lệch 1–3 ngày so với hệ thống cũ — cần kiểm tra đối chiếu.
2. **Ngày bảo dưỡng gần nhất ghi theo UTC** — phê duyệt lúc 00:00–06:59 (GMT+7) bị lùi 1 ngày. Bộ API này dùng ngày nghiệp vụ GMT+7.
3. **Lỗi: đơn bảo dưỡng chỉ lấy hạng mục của đơn đầu tiên** — `GET /api/maintenance-orders/device/:deviceId` bản cũ chỉ gắn hạng mục cho sheet đầu tiên. Đã sửa: lấy hạng mục của tất cả `sheet_no` bằng truy vấn `IN`.
4. **Sinh số đơn `sheet_no` thiếu an toàn** — bản cũ chỉ quét tối đa 1000 dòng không sắp xếp, dễ trùng số khi nhiều đơn trong ngày. Đã sửa: đếm theo tiền tố `EMGI<YYMMDD>` chính xác.
5. **Bộ lọc "factory" của trang BI thực chất lọc theo bộ phận (`mnt_dept_no`)** chứ không phải phân xưởng (`equ_addr`). Giữ nguyên hành vi để tương thích frontend, nhưng đã ghi rõ trong Swagger. Nếu muốn lọc đúng phân xưởng thì phải đổi cả frontend.
6. **Nhận diện khuôn mặt phụ thuộc dịch vụ AI bên ngoài** — hệ thống gốc dùng plugin AI của nền tảng. Bộ API này để 2 biến môi trường tùy chọn (`FACE_QUALITY_URL`, `FACE_COMPARE_URL`); chưa cấu hình thì đăng ký bỏ qua bước kiểm tra chất lượng, còn xác thực trả `success=false`. Cần tích hợp dịch vụ AI của bạn để dùng thật.
7. **Endpoint cũ `POST /api/maintenance-orders/device/:deviceId` (tạo đơn sớm)** không được chuyển sang — frontend hiện tại không còn gọi (đơn chỉ tạo khi approver xác nhận). Nếu cần, báo để bổ sung.
8. **Xác thực dựa vào userId từ client** — giống bản gốc: API không có phiên/token, frontend tự giữ phiên 30 ngày và truyền `userId`. Đây là điểm yếu bảo mật vốn có của thiết kế cũ (ai biết id là gọi được), cần cân nhắc nếu mở API ra ngoài mạng nội bộ.

## 5. Cấu trúc thư mục

```
local-api/
├── package.json
├── .env.example
└── src/
    ├── index.js                 # Khởi động server + Swagger
    ├── config.js                # Đọc .env
    ├── db.js                    # Pool mssql + helper query/transaction
    ├── errors.js                # ApiError + middleware lỗi
    ├── swagger.js               # Định nghĩa OpenAPI 3.0
    ├── middleware/validate.js   # Middleware Joi
    ├── utils/
    │   ├── dates.js             # Ngày nghiệp vụ GMT+7, tính hạn, trạng thái hiệu lực
    │   └── auth.js              # Phân quyền (caller, vị trí, bộ phận)
    ├── services/                # Logic nghiệp vụ 5 module
    └── routes/                  # 5 file định tuyến + Joi schema
```
