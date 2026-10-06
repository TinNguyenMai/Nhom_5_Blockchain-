# Dàn ý báo cáo cuối kỳ

**Tên đề tài:** Thiết kế hệ thống CPS quản lý và giao dịch năng lượng mặt trời P2P tích hợp IoT, AI và Blockchain.

**Dung lượng dự kiến:** 10–15 trang. Phân bổ bên dưới là gợi ý, có thể điều chỉnh theo mẫu của giảng viên.

## Phần đầu — khoảng 1 trang
- Trang bìa: tên học phần, đề tài, giảng viên, nhóm và thành viên.
- Tóm tắt đề tài, từ khóa.
- Mục lục; danh mục hình/bảng nếu cần.

## Chương 1. Giới thiệu đề tài — khoảng 1 trang
1.1. Bối cảnh giao dịch điện mặt trời giữa các hộ.
1.2. Vấn đề cần giải quyết và mục tiêu của hệ thống.
1.3. Phạm vi: số hộ, blockchain local, dữ liệu mô phỏng và phần cứng nếu có.
1.4. Các đóng góp và tính năng nâng cao của nhóm.

## Chương 2. Cơ sở lý thuyết và công nghệ — khoảng 1–1,5 trang
2.1. Kiến trúc CPS và luồng IoT → AI → Blockchain.
2.2. IoT, MQTT và mô hình publish/subscribe.
2.3. Bài toán dự báo điện phát/tải; hồi quy, MLP và lượng tử hóa INT8.
2.4. Blockchain, ERC-20, smart contract, Ethers và ví Web3.

## Chương 3. Phân tích yêu cầu và thiết kế hệ thống — khoảng 2 trang
3.1. Yêu cầu chức năng và phi chức năng.
3.2. Vai trò: hộ bán, hộ mua, điều phối viên/oracle.
3.3. Sơ đồ kiến trúc tổng thể và bố trí các thành phần.
3.4. Thiết kế bản tin MQTT, đơn vị điện/Token, định danh và dữ liệu lưu trữ.
3.5. Sơ đồ trình tự đặt lệnh → khóa tiền → khớp → xác nhận → thanh toán.
3.6. Giả định tin cậy, quyền truy cập và liên kết bằng chứng bằng hash.

## Chương 4. Triển khai hệ thống — khoảng 3–4 trang
4.1. Tầng IoT: sinh số đo nhiều hộ; firmware ESP32, cảm biến/relay nếu sử dụng.
4.2. Tầng AI: dữ liệu 30 ngày, tiền xử lý, cửa sổ 12 mẫu, 53 đặc trưng.
4.3. Huấn luyện MLP hồi quy, chia dữ liệu theo thời gian, xuất Keras/TFLite/INT8.
4.4. Phân biệt mô hình AI đã huấn luyện với dự báo persistence của mô phỏng nhiều hộ.
4.5. Smart contract SolarToken và EnergyMarket; cấu trúc lệnh và giao dịch.
4.6. Escrow, đặt cọc, xác nhận giao đủ/thiếu, hủy lệnh và hoàn tiền quá hạn.
4.7. Điểm uy tín, giới hạn cam kết mua/bán và cơ chế phục hồi điểm.
4.8. Ưu tiên bệnh viện công/tư, mầm non và hộ đặc biệt khi bằng giá.
4.9. Gateway MQTT/Ethers, journal giao dịch, bản tin trùng và phục hồi gián đoạn.
4.10. Backend, dashboard, ví MetaMask và truy vết receipt local.

## Chương 5. Thực nghiệm và đánh giá — khoảng 2–3 trang
5.1. Môi trường chạy, cấu hình và cách tái lập demo.
5.2. Đánh giá AI: MAE/RMSE, baseline persistence, FP32 so với INT8.
5.3. Thực nghiệm luồng tích hợp; chỉ rõ nguồn dự báo của từng chế độ.
5.4. Kết quả mô phỏng 12 hộ và kiểm tra quy mô 32 hộ.
5.5. Bảng 22 kịch bản: đầu vào, kết quả mong đợi, kết quả thực tế.
5.6. Kiểm tra số dư, bảo toàn Token, escrow và hash/receipt.
5.7. Kết quả kiểm thử smart contract, MQTT, ví và giao diện.
5.8. Rủi ro và hạn chế: oracle, công tơ ảo, dữ liệu tổng hợp, gateway giữ khóa demo, thời gian local.
5.9. Đối chiếu yêu cầu nền tảng và các tính năng nâng cao của học phần.

## Chương 6. Kết luận và hướng phát triển — khoảng 0,5–1 trang
6.1. Kết quả đạt được và đóng góp chính.
6.2. Các hạn chế còn lại.
6.3. Hướng phát triển: công tơ xác thực, AI nhiều hộ, ký phân tán và testnet.

## Phần cuối — khoảng 0,5–1 trang
- Tài liệu tham khảo.
- Phụ lục: cấu trúc mã nguồn, lệnh demo, phân công thành viên, liên kết repository/video nếu có.

## Các hình và bảng nên chuẩn bị
- Sơ đồ kiến trúc CPS ba tầng.
- Sơ đồ trình tự và trạng thái giao dịch.
- Bảng cấu hình hộ, topic MQTT và đơn vị dữ liệu.
- Biểu đồ dự báo AI so với thực tế mô phỏng; bảng MAE/RMSE.
- Bảng chính sách uy tín/cọc/giới hạn; minh họa ưu tiên cùng giá.
- Bảng kết quả kiểm thử và ảnh dashboard/receipt.
