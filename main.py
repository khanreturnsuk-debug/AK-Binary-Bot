import os
from flask import Flask, request, jsonify
from datetime import datetime, timezone, timedelta
from tradingview_ta import TA_Handler, Interval

app = Flask(__name__)

# ==================== BOT CONFIGURATION ====================
BOT_NAME = "AK PREMIUM BINARY BOT v2.0"
ADMIN_WHATSAPP = "923231528821"

PAIRS = {
    "1": "EURUSD", "2": "GBPUSD", "3": "USDJPY", "4": "USDCAD",
    "5": "USDCHF", "6": "AUDUSD", "7": "NZDUSD", "8": "EURGBP",
    "9": "EURJPY", "10": "GBPJPY", "11": "AUDJPY", "12": "CADJPY"
}

TIMEFRAMES = {
    "1": ("1 Minute", Interval.INTERVAL_1_MINUTE, 1),
    "2": ("5 Minutes", Interval.INTERVAL_5_MINUTES, 5)
}

def calculate_next_candle_time(tf_minutes):
    utc_now = datetime.now(timezone.utc)
    if tf_minutes == 1:
        next_candle = (utc_now + timedelta(minutes=1)).replace(second=0, microsecond=0)
    else:
        remainder = utc_now.minute % 5
        add_mins = 5 - remainder
        next_candle = (utc_now + timedelta(minutes=add_mins)).replace(second=0, microsecond=0)
        
    seconds_remaining = int((next_candle - utc_now).total_seconds())
    return next_candle.strftime('%H:%M:00 UTC'), seconds_remaining

def fetch_tv_analysis(symbol, timeframe_interval):
    try:
        handler = TA_Handler(
            symbol=symbol,
            screener="forex",
            exchange="FX_IDC",
            interval=timeframe_interval
        )
        return handler.get_analysis()
    except Exception:
        return None

@app.route('/')
def home():
    return jsonify({
        "status": "Online",
        "bot": BOT_NAME,
        "whatsapp": f"+{ADMIN_WHATSAPP}",
        "usage": "Use /signal?pair=EURUSD&tf=1 to get trading signal"
    })

@app.route('/signal', methods=['GET'])
def get_signal():
    symbol = request.args.get('pair', 'EURUSD').upper()
    tf_choice = request.args.get('tf', '1')

    if tf_choice not in TIMEFRAMES:
        return jsonify({"error": "Invalid timeframe. Use 1 or 2."}), 400

    tf_name, tf_interval, tf_minutes = TIMEFRAMES[tf_choice]
    analysis = fetch_tv_analysis(symbol, tf_interval)

    if not analysis:
        return jsonify({"error": f"Failed to fetch data for {symbol}"}), 500

    sum_data = analysis.summary
    buy = sum_data.get("BUY", 0)
    sell = sum_data.get("SELL", 0)
    neutral = sum_data.get("NEUTRAL", 0)
    total = buy + sell + neutral

    if total == 0:
        return jsonify({"error": "No market data available"}), 500

    if buy > sell:
        direction = "CALL (BUY) 🟩"
        acc = round((buy / total) * 100, 1)
    elif sell > buy:
        direction = "PUT (SELL) 🟥"
        acc = round((sell / total) * 100, 1)
    else:
        direction = "NEUTRAL / WAIT 🟡"
        acc = 50.0

    acc = min(acc, 98.5)
    next_entry_utc, seconds_left = calculate_next_candle_time(tf_minutes)

    return jsonify({
        "pair": symbol,
        "timeframe": tf_name,
        "direction": direction,
        "accuracy": f"{acc}%",
        "score": f"{acc} / 100",
        "next_candle_utc": next_entry_utc,
        "prepare_seconds": seconds_left
    })

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port)
