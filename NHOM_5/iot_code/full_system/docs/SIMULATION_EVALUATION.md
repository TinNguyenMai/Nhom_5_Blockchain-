# Đánh giá mô phỏng bằng biểu đồ

Mở `/simulation` sau khi chạy `npm.cmd run dashboard:build` và `npm.cmd run simulation:market`. Phần **Kết quả mô phỏng và bằng chứng** nằm ngay dưới các chỉ số tổng quan. Biểu đồ cập nhật theo từng thao tác được xác nhận; giao diện lấy trạng thái mỗi 1,5 giây.

## Xem kết quả

- Mặc định **Toàn bộ lượt mô phỏng** để thấy diễn biến nhiều phiên. **Kịch bản mới nhất** tự chuyển theo tiến độ chạy khi được chọn. Nút **Xem biểu đồ và bằng chứng** trong danh sách kiểm chứng mở phạm vi tương ứng.
- Bộ lọc hộ trong giao dịch áp dụng cho lượng điện, thống kê giao dịch, phân bổ mua và ma trận. Escrow và bảo toàn Token luôn đối chiếu toàn bộ ví của lượt; hộ theo dõi uy tín được chọn riêng.
- **Điện cam kết và đã giao:** khi xem nhiều phiên, ba đường thể hiện yêu cầu mua, cam kết và đã giao theo từng phiên (kWh/phiên); khi chọn một phiên, hiển thị cột theo giao dịch. Cam kết là lượng đã khớp; lượng giao lấy từ cặp công tơ ảo đã được xác nhận. Giao dịch chờ hoặc quá hạn không có xác nhận lượng giao. Tỷ lệ giao thấp không đồng nghĩa kịch bản thất bại, vì một số kiểm thử cố tình tạo giao thiếu.
- **Tiền đang khóa:** diễn biến escrow theo bước xử lý, kèm số bước bảo toàn Token và sai lệch cuối. Bước xử lý không phải thời gian đo điện; mỗi điểm có thời gian ghi nhận, thời gian chain và thao tác trong CSV.
- **Uy tín:** chọn điểm, tỷ lệ cọc hoặc giới hạn cam kết; có số liệu đầu/cuối của phạm vi. Có thể so sánh với các hộ có biến động và chọn hộ biến động nhất. Hộ không thay đổi chỉ số được ghi rõ, đường nằm ngang vẫn giữ đúng số liệu.
- **Yêu cầu mua và lượng được khớp:** toàn lượt cộng theo hộ; một phiên hiển thị theo lệnh. Trỏ vào cột theo lệnh để xem giá, nhóm ưu tiên và thứ tự đặt.
- **Điện phát và phụ tải cộng đồng:** tổng công suất của toàn bộ hộ tại mỗi lần lấy mẫu, đơn vị kW. Bộ lọc giao dịch không thay đổi tổng này.
- **Ma trận giao dịch:** hàng là bên bán, cột là bên mua; màu biểu thị kWh đã khớp, không phải điện thực đã giao.
- **Bằng chứng số liệu và biên lai:** bảng tiền trả/hoàn/phạt, hash công tơ ảo và transaction hash của từng bước.

## Kịch bản dữ liệu biến động

Chọn **Cộng đồng biến động · 12 phiên** (`--scenario community`, mặc định). Kịch bản có 12 khoảng liên tiếp, mỗi khoảng 5 phút: nắng/mây/mưa làm thay đổi nguồn phát, lịch tải riêng từng hộ tạo lúc dư cung và thiếu cung. Nhà 1 gặp gián đoạn ở phiên 4, giao 40% ở phiên 5 và gián đoạn lại ở phiên 9; Nhà 7 giao 70% ở phiên 6, Nhà 8 không giao ở phiên 9. Sự cố lặp lại khiến cọc và giới hạn thay đổi theo contract; các phiên giao đủ sau đó phục hồi uy tín. Nút sự kiện trên biểu đồ mở bằng chứng của phiên tương ứng.

Nguồn số đo là mô hình tổng hợp với seed cố định. Đề xuất được tạo từ đúng điện ròng từng hộ, lệnh đi qua MQTT và smart contract; không sửa lượng khớp, số dư hoặc điểm uy tín để tạo hình đẹp. `full-demo` vẫn giữ bộ 22 kiểm thử chức năng độc lập.

## Công thức và phạm vi tiền

Tính toán báo cáo dùng số nguyên Wh và micro-SLC, cùng quy tắc với contract. Chỉ đổi sang kWh/SLC khi hiển thị.

- Đã trả khi xác nhận = `delivered_wh * price`.
- Tiền điện hoàn khi xác nhận/quá hạn = `cost - paid`; giao dịch đang chờ chưa được tính là hoàn tiền.
- Cọc phạt khi giao thiếu = `seller_collateral * (quantity_wh - delivered_wh) / quantity_wh`, chia nguyên làm tròn xuống.
- Bảo toàn = tổng số dư các ví tham gia + escrow = tổng Token ban đầu của các ví tham gia. Phạm vi này không phải tổng cung ERC-20 gồm cả ví điều phối.

Chỉ số tiền hoàn trên đầu trang chỉ tính tiền điện đã khớp. Nó không cộng cọc được hoàn, tiền lệnh hủy hoặc tiền chưa khớp. Số dư ví và escrow phản ánh cả các khoản này. Cọc phạt được chuyển cho người mua, không bị đốt.

Ví dụ trong `full-demo`, kịch bản giao 40% cam kết 100 Wh, xác nhận 40 Wh, trả 0,08 SLC, hoàn 0,12 SLC và phạt cọc 0,012 SLC. Người bán có điểm 60 → 40, cọc 10% → 25%. Lượt này đạt nếu contract thực hiện đúng các kết quả mong đợi.

## Xuất hình và dữ liệu

Mỗi biểu đồ có nút **SVG** và **PNG**. SVG giữ chữ và đường nét dạng vector; PNG xuất với chiều rộng 1.600 px. Hình có tiêu đề, đơn vị, chú giải và mã lượt/phạm vi. **CSV giao dịch** giữ đơn vị Wh/micro-SLC chính xác, **CSV diễn biến** lưu toàn bộ bước trong phạm vi và uy tín của hộ đang chọn. CSV dùng UTF-8 BOM để mở tiếng Việt trong Excel.

JSON vẫn có tại `/simulation/report`; các lượt mới bổ sung `evaluation` và `checks[].evidence`. `evaluation-history.json` và `snapshot.json` trong thư mục từng lượt giữ dữ liệu sau mỗi bước. Gateway khởi động lại trong cùng lượt không làm mất lịch sử. Báo cáo cũ vẫn xem được biểu đồ giao dịch của toàn lượt; cần chạy lượt mới để có lịch sử và liên kết kịch bản.

## Đánh giá AI riêng

Biểu đồ MAE/RMSE đọc `ai_model/artifacts/evaluation.json`: tập test 5 ngày với 1.440 mẫu Nhà 1, có bộ lọc ban ngày/ban đêm và điện phát/tải. Đây là dữ liệu tổng hợp và kết quả đánh giá đã lưu, không phải kết quả AI của lượt thị trường hiện tại.

Biểu đồ chuỗi đọc `ai_model/artifacts/visualization.json`. Bản đi kèm được xuất từ 276 dự báo INT8 thực thi trên ESP32 đã ghép với telemetry mô phỏng trong `data/edge_20260925_212015/scores.csv`; nguồn này khác tập test 5 ngày. Giao diện ghi rõ nguồn và cho chọn ngày, đại lượng, xuất CSV. Mặc định xem một giờ có biên độ lớn nhất trong ngày, gồm 12 mẫu liên tiếp, kèm trục Y phóng đại được ghi rõ; có thể chuyển về toàn ngày hoặc trục từ 0. Biểu đồ sai lệch có dấu (dự báo − giá trị mô phỏng) làm rõ chỗ dự báo cao/thấp. Không tạo thêm dự báo giả hoặc trộn hai nguồn thành một chỉ số.

Xuất lại chuỗi ESP32 đã ghi bằng Python chuẩn, không cần TensorFlow:

```powershell
python -m ai_model.export_visualization --scores data/edge_20260925_212015/scores.csv
```

Nếu có môi trường TensorFlow phù hợp, `python -m ai_model.evaluate` đánh giá lại model trên đúng dataset đã ghi hash, đồng thời thay `visualization.json` bằng toàn bộ chuỗi test persistence/FP32/INT8. Không huấn luyện lại model. Dashboard chỉ ghép chuỗi và bảng sai số khi cùng `model_version`.

Toàn bộ thị trường chạy Hardhat local; `physical_delivery_verified=false`. Biểu đồ không chứng minh việc truyền điện vật lý giữa các hộ.
