# Phase 4 — cập nhật màn hình chọn đề xuất

Ngày: 27/09/2026.

## Hiện tượng và nguyên nhân

Ảnh dashboard cho thấy ví Điều phối đã kết nối đúng mạng local, trang Thị trường đang để “Chọn đề xuất…” và chưa có phiên. Nút “Chuẩn bị nguồn” bị khóa vì chưa chọn đề xuất. Ảnh chưa cho thấy lỗi backend hay lỗi blockchain; giao diện cũ thiếu hướng dẫn ngay tại bước này.

## Nội dung sửa

- Hiển thị ba bước: Chọn đề xuất → Chuẩn bị nguồn → Mở phiên bằng ví.
- Thêm nút “Chọn đề xuất mới nhất” trong các đề xuất phù hợp của danh sách đã tải. Nút chỉ điền lựa chọn, không tự mở phiên hay gửi giao dịch.
- Hiển thị số đề xuất đã tải và số có thể chọn; chỉ rõ nếu danh sách giới hạn ở 500 đề xuất mới nhất.
- Phân biệt đang tải, chưa có dữ liệu, đã lọc hết đề xuất và lỗi tải. Có nút thử lại và chuyển Live sang Replay khi phù hợp.
- Nêu lý do nút chuẩn bị/mở phiên bị khóa; chặn chuẩn bị từ dữ liệu lưu tạm khi yêu cầu tải mới đang lỗi.
- Sửa chiều rộng danh sách chọn trên màn hình nhỏ.

Bản vá gồm `dashboard/src/App.jsx`, `dashboard/src/style.css`, `dashboard/tests/run.mjs` và hướng dẫn này. Không thay hợp đồng, dữ liệu SQLite, cấu hình MQTT hay firmware.

## Cập nhật khi hệ thống đang chạy

1. Trong VS Code, chọn đúng terminal đang chạy `npm.cmd run dashboard`, nhấn Ctrl+C. Giữ Hardhat, backend và Mosquitto đang chạy. Không chạy thêm `npm.cmd run chain` và không deploy lại.
2. Giải nén `p2p-solar-phase4-market-fix.zip` vào thư mục tạm. Bên trong có thư mục `dashboard` và file hướng dẫn.
3. Chép hai mục đó vào thư mục dự án `p2p-solar-phase1`, chọn ghi đè file trùng tên. Chép **nội dung** gói vá vào gốc dự án, không đặt cả thư mục giải nén bên trong `dashboard`.
4. Tại terminal dashboard, chạy:

```powershell
cd "C:\ANOTHER_DISK\HCMUTE\4th_YEAR\FIRST\31Blockchain\p2p-solar-phase1"
npm.cmd run dashboard:build
```

Khi build thành công, chạy:

```powershell
npm.cmd run dashboard
```

5. Mở `http://127.0.0.1:5173`, nhấn Ctrl+F5. Kết nối lại MetaMask bằng ví Điều phối nếu trang trở về chế độ xem.

Gói vá sử dụng các dependency đã cài ở Phase 4; không cần cài lại Node/npm.

## Tiếp tục lượt giao dịch

1. Vào **Thị trường**, giữ **Replay** và chọn lượt dữ liệu đã lưu.
2. Bấm **Chọn đề xuất mới nhất**, kiểm tra thời gian, hành động Mua/Bán và số kWh.
3. Bấm **Chuẩn bị nguồn**. Chờ thông báo nguồn sẵn sàng.
4. Chọn **10 phút** ở thời gian đặt lệnh để có thời gian chuyển tài khoản khi tập thao tác.
5. Bấm **Mở phiên bằng ví Điều phối**, kiểm tra mạng Solar Local và xác nhận trong MetaMask.
6. Khi hiện phiên mới, chuyển ví sang **Nhà 1**, xem lại lệnh theo dự báo, đặt giá bán 2 SLC/kWh hoặc giá mua 3 SLC/kWh, rồi ký gửi lệnh.
7. Chuyển sang **Nhà 2**, đặt lệnh đối ứng cùng năng lượng: Nhà 1 bán thì Nhà 2 mua giá 3; Nhà 1 mua thì Nhà 2 bán giá 2. Lệnh mua cần cấp quyền SLC rồi gửi lệnh trong ví.
8. Chờ hết thời gian đặt lệnh, bấm **Kết toán phiên** và xác nhận. Khi có 2 lệnh phù hợp sẽ khớp 1 giao dịch. Xuất báo cáo JSON để lưu bằng chứng.

Nếu danh sách không có đề xuất, đọc thông báo ngay dưới ô chọn. Replay vẫn dùng được khi simulator đã dừng. Không cần chạy lại dữ liệu chỉ vì lượt hiện `stopped`.

## Kiểm tra bản sửa

Đã build thành công và chạy kiểm tra Chromium với FastAPI/SQLite và Hardhat cục bộ: các trạng thái danh sách, thử tải lại, chọn đề xuất không gửi giao dịch, chuyển Live/Replay, bố cục 390px và toàn bộ luồng mở phiên → đặt lệnh → kết toán → biên nhận → xuất JSON. Kiểm tra thêm hủy lệnh/hoàn SLC, đổi tài khoản và đổi mạng vẫn qua.

Ví trong kiểm tra tự động là bộ mô phỏng EIP-1193; dự báo là fixture kiểm thử. Kết quả đó không thay thế việc xác nhận trên MetaMask và ESP32 thật của bạn.
