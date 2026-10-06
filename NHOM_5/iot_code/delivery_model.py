"""Paired virtual meters: deterministic integer Wh, never real energy evidence."""


def delivery_record(meters, seller, buyer, quantity_wh, delivery_bps):
    if type(quantity_wh) is not int or quantity_wh < 1 or type(delivery_bps) is not int or not 0 <= delivery_bps <= 10000:
        raise ValueError("Invalid delivery quantity or ratio")
    delivered = quantity_wh * delivery_bps // 10000
    export_start = meters.get(seller + ":export", 0)
    import_start = meters.get(buyer + ":import", 0)
    meters[seller + ":export"] = export_start + delivered
    meters[buyer + ":import"] = import_start + delivered
    return {
        "delivered_wh": str(delivered),
        "measurement": {
            "kind": "paired_simulated_meters", "seller": seller, "buyer": buyer,
            "seller_meter_id": seller + ":export", "buyer_meter_id": buyer + ":import",
            "seller_start_wh": str(export_start), "seller_end_wh": str(export_start + delivered),
            "buyer_start_wh": str(import_start), "buyer_end_wh": str(import_start + delivered),
        },
    }
