# Khóa Token, uy tín và ưu tiên người mua

Cập nhật 03/10/2026. `EnergyMarket.MARKET_VERSION()` trả về `2`. Hướng dẫn này thay thế mô tả thanh toán ngay khi kết toán trong tài liệu Phase 3/4 cũ.

Đã bổ sung mô phỏng nhiều hộ qua MQTT tại [MQTT_MARKET_SIMULATION.md](MQTT_MARKET_SIMULATION.md). Loại nguồn `Basis.SimulatedForecast=2` đánh dấu đề xuất công tơ ảo; enum nguồn cũ 0/1 được giữ nguyên. Bản contract có loại nguồn này cần triển khai mới; CLI mô phỏng tự tạo triển khai riêng.

## Khóa Token và xác nhận giao điện

1. `placeOrder`: người mua khóa **Wh × giá đặt mua** cộng đặt cọc theo uy tín; người bán cũng khóa đặt cọc nếu thuộc nhóm cần cọc. `quoteOrder` trả về tiền và cọc cần khóa; phải `approve` đủ Token.
2. `settle`: sau hạn đặt lệnh, bất kỳ ví nào cũng khớp lệnh theo giá bán. Hoàn phần không sử dụng và chênh lệch giá; **tiền phần khớp và cọc tương ứng tiếp tục bị khóa**.
3. `confirmTrade(roundId, tradeIndex, deliveredWh, evidenceHash)`: chỉ điều phối viên xác nhận lượng điện thực giao. Người bán nhận `deliveredWh × giá khớp`; người mua được hoàn tiền phần chưa giao. Hash phải khác zero và chưa dùng cho giao dịch khác. Không thể trả hai lần.
4. Giao thiếu: giảm uy tín người bán, chuyển phần cọc tỷ lệ với điện chưa giao cho người mua; hoàn cọc còn lại. Cọc người mua hoàn toàn bộ.
5. Hạn xác nhận: **24 giờ sau hạn đặt lệnh**, theo thời gian blockchain. Từ đúng thời điểm đó, xác nhận bị chặn; bất kỳ ví nào gọi được `expireTrade` để hoàn tiền và cọc. Thiếu xác nhận được ghi là hết hạn, không tự quy lỗi cho hộ.

`round.settled` nghĩa là đã khớp sổ lệnh, chưa có nghĩa mọi giao dịch đã thanh toán. `getTrades` lưu `Pending=0`, `Confirmed=1`, `Expired=2`, điện thực giao, hash và cọc. `Confirmed` bao gồm cả kết quả xác nhận giao thiếu. `TradeExecuted` là sự kiện khớp; `TradeConfirmed` ghi lượng giao, tiền đã trả và phạt.

Điều phối viên là oracle: phải kiểm tra bằng chứng công tơ trước khi xác nhận. Hợp đồng kiểm tra quyền, lượng, thời hạn, hash và trạng thái; **hash không tự chứng minh số đo là thật**. Replay/demo không tự xác nhận từ dự báo. Báo cáo giữ `energy_delivery_verified: false` vì chưa có xác thực công tơ vật lý độc lập.

## Uy tín và chính sách mặc định

Ví đã đăng ký bắt đầu ở **100 điểm**, trong khoảng 0–100. Giao đủ được xác nhận: cả hai bên cộng 2, tối đa 100. Giao thiếu được xác nhận: người bán trừ 20, tối thiểu 0. Người mua đã khóa đủ tiền nên không bị quy lỗi thanh toán. Hủy đúng hạn, không khớp, hết hạn chưa xác nhận không thay đổi điểm.

`reputations(address)` lưu điểm, số lệnh đặt/hủy, số giao dịch thành công, vi phạm, hết hạn và tổng điện giao/nhận đã xác nhận. Sổ lệnh, giao dịch và sự kiện lưu lịch sử để đối chiếu.

| Điểm | Tổng điện cam kết tối đa | Cọc thêm trên giá trị lệnh |
| --- | ---: | ---: |
| 80–100 | 1.000.000.000 Wh | 0% |
| 50–79 | 500.000.000 Wh | 10% |
| 0–49 | 100.000.000 Wh | 25% |

Các mức trên là chính sách demo; thay đổi cần chỉnh hợp đồng và triển khai mới. Cọc làm tròn lên đến micro-SLC. Giới hạn áp dụng cả mua và bán, cộng dồn **mọi phiên mở và giao dịch chờ xác nhận**, tránh chia lệnh giữa các phiên để né. Cam kết cũ giữ mức cọc đã khóa; điểm mới áp dụng cho lệnh tiếp theo.

Ví dụ: hai lần giao thiếu làm điểm từ 100 xuống 60. Lệnh bán 100 Wh, giá 2.000 micro-SLC/Wh cần cọc 20.000. Nếu chỉ giao 40 Wh, người bán nhận 80.000 tiền điện và hoàn 8.000 cọc; người mua được hoàn tiền 60 Wh chưa giao và nhận 12.000 tiền phạt.

## Ưu tiên cùng giá mua

`BuyerCategory`: `Ordinary=0`, `Hospital=1`, `Kindergarten=2`, `SpecialHousehold=3`. Bệnh viện tư/công cùng nhóm Hospital; các nhóm ưu tiên ngang nhau.

Chỉ điều phối viên gọi được `setBuyerCategory(trader, category, verificationHash)`, với ví đã đăng ký và hash hồ sơ khác zero. Hộ không tự nhận nhóm. Nhóm được chụp trong lệnh lúc đặt; thay đổi sau đó áp dụng cho lệnh mới.

Thứ tự mua: **giá cao hơn → nhóm ưu tiên nếu cùng giá → đến trước nếu vẫn ngang nhau**. Thứ tự bán: giá thấp hơn rồi đến trước. Uy tín vẫn giới hạn lượng và cọc của mọi nhóm.

## Biên dịch và triển khai

```powershell
npm.cmd run compile
npm.cmd test
npm.cmd run dashboard:build
# Giữ npm.cmd run chain chạy trong terminal riêng.
npm.cmd run deploy
```

Hợp đồng cũ không nâng cấp tại chỗ. `deploy` kiểm tra `MARKET_VERSION`, tạo triển khai mới nếu bản cũ đang được lưu; bản mới dùng Token demo mới và lịch sử riêng. Không di chuyển tiền/lịch sử từ hợp đồng cũ. Nếu còn lệnh bản cũ, xử lý theo bản cũ trước khi chuyển. Không cần xóa database hay dữ liệu firmware. Nếu bản 2 đang hoạt động, `deploy` dùng lại địa chỉ đó.

## CLI local

Các lệnh dùng tài khoản điều phối viên Hardhat ở localhost. Bằng chứng JSON được giữ trong thư mục báo cáo theo triển khai. Index giao dịch bắt đầu từ 0.

### Xác nhận giao điện

Tạo `delivery.json` từ số đo đã kiểm tra:

```json
{
  "deployment_id": "<deployment_id trong data/phase3/deployment.json>",
  "round_id": "1",
  "trade_index": 0,
  "delivered_wh": "100",
  "measurement": {
    "meter_id": "meter-home-01",
    "reading_start_wh": "12000",
    "reading_end_wh": "12100",
    "verified_by": "coordinator"
  }
}
```

```powershell
npm.cmd run market:confirm -- --round 1 --trade 0 --evidence .\delivery.json
```

CLI kiểm tra triển khai/phiên/index và băm toàn bộ JSON theo `canonical`. Điều phối viên chịu trách nhiệm kiểm tra nội dung số đo. Xác nhận 0 Wh nghĩa là đã xác minh không giao điện, khác với chưa có bằng chứng.

### Đăng ký nhóm ưu tiên

Tạo `priority.json`:

```json
{
  "deployment_id": "<deployment_id hiện tại>",
  "trader": "<địa chỉ ví home_02>",
  "category": "hospital",
  "verification": { "record_id": "<hồ sơ cơ sở>", "verified_by": "coordinator" }
}
```

```powershell
npm.cmd run market:priority -- --home home_02 --category hospital --evidence .\priority.json
```

Nhóm CLI: `ordinary`, `hospital`, `kindergarten`, `special`. Dùng `ordinary` kèm hồ sơ để bỏ ưu tiên cho lệnh mới.

### Hoàn tiền quá hạn

```powershell
npm.cmd run market:expire -- --round 1 --trade 0
npm.cmd run market:settle
npm.cmd run market:report
```

`market:expire` xử lý một giao dịch quá hạn; `market:settle` khớp phiên tới hạn và hoàn giao dịch quá hạn xác nhận. Gọi trực tiếp `expireTrade` từ ví khác không cần điều phối viên. Dashboard hiển thị cọc dự kiến, tiền khóa và trạng thái chờ/đã xác nhận/đã hoàn; xác nhận và gán nhóm dùng CLI hoặc API hợp đồng.

## Kiểm thử

```powershell
npm.cmd test
node --test dashboard/tests/wallet.test.mjs
npm.cmd run test:integration
npm.cmd run test:phase4
```

Bao phủ quyền xác nhận, khóa/hoàn tiền, hash trùng/rỗng, lượng sai, cấm trả hai lần, quá hạn, giao thiếu/phạt, sàn/trần và khôi phục điểm, cọc hai bên, giới hạn cộng dồn, nhiều phiên giữ tiền độc lập và thứ tự ưu tiên. Số đo trong kiểm thử là dữ liệu tổng hợp.

Kết quả trên máy ngày 03/10/2026: 27/27 kiểm thử hợp đồng/bridge, 10/10 kiểm thử ví, kiểm thử tích hợp FastAPI/SQLite/Hardhat và kiểm thử dashboard đều đạt. Dashboard được kiểm thử bằng Chrome đã cài (biến `SOLAR_BROWSER_BIN`), vì Chromium riêng của Playwright chưa có. Biên dịch Solidity và bản build dashboard thành công; sau khi thêm loại nguồn mô phỏng, hợp đồng có 12.409 byte mã triển khai.
