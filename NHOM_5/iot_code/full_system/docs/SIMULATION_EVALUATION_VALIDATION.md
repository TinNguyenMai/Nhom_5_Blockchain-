# Kiểm tra biểu đồ đánh giá — 05/10/2026

Đã kiểm tra trên Windows với Node 24.16.0, Python 3.11 trong `.venv-runtime`, Mosquitto và Chrome headless. Môi trường `.venv-backend` hiện trỏ tới Python 3.12 không còn chạy được trên máy này; các kiểm thử dùng `SOLAR_TEST_PYTHON` trỏ tới `.venv-runtime/Scripts/python.exe`. Sandbox Windows gặp lỗi `os.userInfo()` khi khởi chạy Hardhat; kiểm thử tích hợp được chạy ngoài sandbox với blockchain/broker local và ví Hardhat công khai.

| Hạng mục | Kết quả |
|---|---|
| Build dashboard | Đạt; phần mô phỏng được tải riêng, chunk cũ của ứng dụng vẫn có cảnh báo >500 kB |
| `test:simulation`: kiểm thử Python | 5/5 đạt, gồm tính lặp lại và đơn vị số đo của hồ sơ cộng đồng |
| `test:simulation`: kiểm thử Node | 3/3 đạt; full-demo 22 kịch bản với 12 ví, phục hồi trước/sau broadcast và thị trường 32 hộ |
| Bằng chứng giao thiếu 40% | Cam kết 100 Wh, giao 40 Wh, trả 80.000 micro-SLC, hoàn 120.000, phạt 12.000; điểm 60 → 40 |
| Lịch sử và bảo toàn | Ghi số dư/escrow/uy tín theo từng thao tác; chỉ số bước liên tiếp, tổng Token đúng từng bước; lịch sử còn sau thay gateway |
| UI full-demo | 22/22 đạt qua nút chạy; từ chối khởi chạy trùng và các HTTP request không hợp lệ |
| Bộ lọc và biểu đồ UI | Đạt: phạm vi kịch bản, hộ, điểm/cọc/giới hạn, phân bổ ưu tiên, MAE/RMSE và điện phát/tải AI |
| Xuất SVG, PNG, CSV, JSON | Đã tải thật qua Chrome; kiểm tra chữ SVG, chữ ký PNG và số liệu CSV trường hợp 40% |
| Lưu và mở lại | Đạt sau dừng chain/reload; báo cáo cũ thiếu lịch sử vẫn mở được và không tự tạo dữ liệu diễn biến |
| Bố cục | Kiểm tra ảnh desktop và màn hình 390 px, không tràn ngang trang; biểu đồ trên điện thoại cuộn ngang trong khung riêng |
| JavaScript trình duyệt | Không ghi nhận pageerror |

Các kiểm tra trình duyệt được chạy trên lượt full-demo mới; sau khi sửa tên hộ trong assertion, phần kiểm tra giao diện được chạy lại trên chính báo cáo đã lưu, không tạo lại giao dịch. Lượt UI lưu 195 điểm lịch sử, 27 phiên và escrow cuối bằng 0.

Ảnh tại `dashboard/test-results/simulation-evaluation.png` và `simulation-evaluation-mobile.png`. Ảnh xuất của kịch bản 40% và CSV đã tải cũng lưu tại `dashboard/test-results/evaluation-*`.

Chuỗi AI tham khảo có 276 mục tiêu ghép đôi từ dự báo ESP32 đã lưu và telemetry mô phỏng. Không chạy lại TensorFlow/huấn luyện trong lần cập nhật này; MAE/RMSE vẫn là kết quả test đã có trong `ai_model/artifacts/evaluation.json`, nguồn chuỗi được ghi riêng trên giao diện.

## Bổ sung dữ liệu biến động

`test:community` đạt trên 12 hộ với 12 phiên, 92 giao dịch, 289 điểm lịch sử. Có cả dư cung và thiếu cung: tổng phát khoảng 7,085–24,133 kW, tải 13,637–32,467 kW. Điện khớp từng phiên nằm trong 37–1.248 Wh. Nhà 1 có điểm 100 → 30 → 44; cọc đi qua 0%, 10%, 25%, giới hạn thay đổi theo contract. Phiên 9 phạt 25.800 micro-SLC. Escrow cuối bằng 0 và bảo toàn Token ở toàn bộ 289 bước.

`test:community:ui` đạt: mặc định toàn lượt, 12 nhãn sự kiện, ba đường điện khác màu, ba hộ biến động uy tín, biểu đồ phát/tải, vùng AI 12 mẫu/toàn ngày và đường sai lệch, bộ lọc hộ/phiên, tải PNG và bố cục 390 px. Tỷ lệ Nhà 1 ở phiên 5 là 140/352 Wh = 39,8% sau làm tròn số nguyên trên từng giao dịch; không ép hiển thị 40%. Không có pageerror.

Đã kiểm tra trực quan ảnh `dashboard/test-results/community-evaluation.png`, `community-energy.png` và bố cục điện thoại bằng kiểm thử trình duyệt. Luồng JSON Python → Node được sửa để nhãn tiếng Việt truyền đúng trên Windows; gateway chờ đủ telemetry và prediction của cùng khoảng trước khi dùng số đo.

Chạy lại kiểm thử:

```powershell
$env:SOLAR_TEST_PYTHON = (Resolve-Path .venv-runtime/Scripts/python.exe).Path
$env:SOLAR_COMMUNITY_TEST_DIR = Join-Path (Get-Location) ('build/community-' + [guid]::NewGuid().ToString('N'))
npm.cmd run test:community
npm.cmd run test:community:ui
```
