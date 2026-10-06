# Kết quả kiểm thử Phase 3

Ngày: 27/09/2026. Phiên bản mã: 3.0.0.

## Phạm vi và môi trường

- Linux, Node.js 24.19.0, npm 11.9.0, Python 3.12.
- Hardhat 3.18.0, Ethers 6.17.0, solc-js 0.8.28, OpenZeppelin Contracts 5.4.0.
- Compiler optimizer 200 runs, EVM target `paris`.
- Mỗi lượt test Node dùng Hardhat node riêng trên cổng tạm. Integration dùng SQLite và thư mục state tạm, không truy cập database người dùng.
- Hướng dẫn Windows dùng PowerShell và `npm.cmd`; chưa trực tiếp chạy bộ này trên máy Windows của người dùng.
- Dự báo dùng trong integration là **fixture tổng hợp**, không phải kết quả inference ESP32 của lượt test này. Luồng ESP32 thật đã được người dùng kiểm chứng ở Phase 2; cần làm bước live trong PHASE3.md để kiểm chứng phần blockchain trên máy người dùng.

## Kết quả

| Kiểm thử | Kết quả |
|---|---|
| `npm test` | 17/17 đạt |
| Integration FastAPI + SQLite + Ethers + Hardhat | Đạt |
| Replay fixture | 3 phiên, 9 lệnh, 6 khớp |
| Live CLI với fixture readiness | 1 phiên live, 3 lệnh, 2 khớp |
| Chạy lại cùng dữ liệu | Không thêm phiên, không thay đổi số dư lần nữa |
| Gọi deploy lần nữa trên chain hiện tại | Dùng lại deployment, không cấp lại token |
| Hợp đồng biến mất/chain thay đổi | Phát hiện, không xác nhận biên lai cũ trên chain mới |
| Liên kết proposal → receipt ở API | `on_chain=true` khi xác minh được; `null` khi chain cũ không còn |
| Kiểm thử hồi quy backend Phase 2 | 23/23 đạt, gồm MQTT integration |
| Cú pháp JavaScript bridge và cột dashboard mới | Đạt |

Không có lỗi test. Pytest hiện hai cảnh báo deprecation từ thư viện FastAPI/httpx và passlib/crypt; không ảnh hưởng kết quả. Không có kiểm thử giao diện bằng trình duyệt hoặc kiểm toán bảo mật độc lập trong phạm vi này.

## Các tình huống đã kiểm tra

1. Token có đúng 6 decimals, tổng cung cố định, mỗi nhà được cấp 1.000 SLC.
2. Ký quỹ đủ, khớp nhiều đối tác, thanh toán giá ask và hoàn chênh lệch giá bid.
3. Ưu tiên bid cao hơn; cùng giá ask thì lệnh đến trước; khớp một phần và lượng còn lại đúng.
4. Không khớp khi bid thấp hơn ask; hoàn toàn bộ tiền đã giữ.
5. Chính chủ hủy trước hạn, không được hoàn hai lần; người khác không hủy được.
6. Chỉ coordinator mở phiên; ví không đăng ký không đặt lệnh được.
7. Không settle sớm, không settle hai lần, không đặt lệnh sau khi đóng.
8. Không lặp roundKey, không đặt hai phía từ một ví trong một phiên, không tái dùng sourceId kể cả đã hủy.
9. Từ chối lượng 0/quá lớn, giá 0, source ID rỗng, phiên không tồn tại.
10. Thiếu allowance hoặc thiếu token: revert toàn bộ, không để lại lệnh giả hay đánh dấu source đã dùng.
11. Hai phiên giữ token đồng thời không trộn tiền ký quỹ.
12. Quy đổi kWh → Wh làm tròn xuống, không bán quá khối lượng đề xuất; từ chối số không hữu hạn và độ chính xác vượt schema.
13. Mã băm dữ liệu nguồn xác định được, thay dữ liệu làm thay mã băm.
14. Live từ chối đề xuất hết hạn, đã quan sát, đã dừng, đến trễ, hold và sai liên kết số đo.
15. Replay cho phép lịch sử hợp lệ nhưng giữ nhãn `replay`; không giả lịch sử thành live.
16. Chỉ chấp nhận URL loopback HTTP, không nhận URL mạng ngoài hoặc thông tin đăng nhập nhúng trong URL.
17. Luồng HTTP/SQL/EVM đầy đủ, liên kết dữ liệu nguồn, receipt status, số dư, chống trùng và deployment mới.

Integration live chỉ giả lập trạng thái MQTT ready trong tiến trình fixture kiểm thử. Nó dùng nguyên CLI live và API/SQLite thật, xác nhận phiên theo thời gian chờ thật. Không sửa chức năng ready của backend sản phẩm.

## Minh họa số dư từ fixture tích hợp

Ba phiên fixture:

- Nhà 1 bán 133 Wh với giá 2 SLC/kWh → nhận 0,266 SLC.
- Nhà 1 mua 100 Wh: 50 Wh giá 2 và 50 Wh giá 2,5 → trả 0,225 SLC.
- Nhà 1 bán 100 Wh giá 2 → nhận 0,2 SLC.

| Ví | Số dư cuối (SLC) |
|---|---:|
| home_01 | 1000,241 |
| home_02 | 999,868 |
| home_03 | 999,891 |
| Hợp đồng thị trường | 0 |

Tổng ba ví vẫn bằng 3.000 SLC. Số dư này chỉ dành cho fixture; số liệu thật của người dùng phụ thuộc các đề xuất được chọn. ETH phí gas là ETH local riêng, không trừ vào số dư SLC.

## Những điều chưa được khẳng định

- Chưa chứng minh việc giao điện thật, độ chính xác dự báo ngoài dữ liệu mô phỏng hoặc giao dịch tài chính thực tế.
- Chưa có MetaMask, deployment testnet, oracle/chữ ký thiết bị hay chứng thực AI trên chain.
- Kiểm tra receipt ở API xác nhận transaction thành công thuộc deployment hiện tại. Kiểm tra đầy đủ hash file nguồn thực hiện bằng `npm run market:report`.
- Book bị chặn tối đa 32 lệnh nhưng chưa đo hiệu năng cực hạn với 32 ví; demo triển khai ba ví.
- Hợp đồng và bridge phù hợp kiểm thử học thuật cục bộ; chưa qua audit sản phẩm tiền thật.

## Tái lập

```powershell
npm.cmd ci
npm.cmd test
npm.cmd run test:integration
```

Kiểm tra hồi quy backend nếu muốn:

```powershell
.\.venv-backend\Scripts\python.exe -m pip install -r .\backend\requirements-test.txt
.\.venv-backend\Scripts\python.exe -m pytest backend/tests -q
```

Xem PHASE3.md, mục 4–6, để chạy replay trên dữ liệu đã lưu và demo trực tiếp với ESP32 thật.
