# Kết quả kiểm thử mô phỏng MQTT

Kiểm tra ngày 03/10/2026 trên Windows, dùng Python trong `.venv-backend`, Mosquitto đã cài, Node/Hardhat và Chrome headless. MQTT và smart contract chạy thật trên localhost; dữ liệu điện, hồ sơ ưu tiên và công tơ là dữ liệu tổng hợp.

| Lệnh | Kết quả |
| --- | --- |
| `npm.cmd run test:simulation` | Đạt 4/4 test Python, 3/3 test Node |
| Bộ `full-demo` trong test Node | Đạt 22/22 kịch bản với 12 ví riêng |
| Test phục hồi trước broadcast | Cùng raw transaction/hash, chỉ một lệnh on-chain; ID khác nội dung bị chặn |
| Test 32 hộ | 32 MQTT client hộ, 32 lệnh trong phiên, giao dịch được xác nhận, bảo toàn Token, escrow = 0 |
| `npm.cmd run test:simulation:ui` | Đạt chạy qua giao diện, lọc hộ, receipt, tải JSON, bố cục 390px, HTTP validation; không có lỗi JavaScript |
| `npm.cmd test` | Đạt 27/27 kiểm thử hợp đồng và bridge |
| `npm.cmd run test:phase4` | Đạt 10/10 test ví và luồng trình duyệt Phase 4 cũ |
| Build dashboard và kiểm tra cú pháp các module mới | Thành công |

Contract `EnergyMarket` sau thêm `Basis.SimulatedForecast` có 12.409 byte mã triển khai. Build Vite còn cảnh báo chunk của ứng dụng cũ trên 500 kB; phần mô phỏng được tải riêng bằng lazy import.

Các kiểm tra bao phủ khóa/hoàn Token, giữ tiền sau khớp, xác nhận giao đủ/thiếu, phạt cọc, điểm/giới hạn, cả bệnh viện công và tư, các nhóm ưu tiên ngang giá, quyền/hạn giao dịch, công tơ sai, nhiều phiên, bản tin lặp, gateway dừng trước broadcast/sau receipt và broker khởi động lại.

Ảnh đã kiểm tra tại `dashboard/test-results/simulation-overview.png`, `simulation-mobile-overview.png`; ảnh toàn trang tại `simulation-desktop.png`, `simulation-mobile.png`.

Không dùng ESP32 hoặc ví MetaMask thật trong kiểm thử này. Công tơ ảo được kiểm tra tính nhất quán bởi gateway/oracle; báo cáo luôn ghi `physical_delivery_verified=false`. Hướng dẫn chạy và cấu trúc hồ sơ tại [MQTT_MARKET_SIMULATION.md](MQTT_MARKET_SIMULATION.md).
