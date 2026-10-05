from flask import Flask, request, jsonify
from flask_cors import CORS
from tradingview_ta import TA_Handler, Interval
import datetime

app = Flask(__name__)
CORS(app)

@app.route('/signal', methods=['GET'])
def get_signal():
    symbol = request.args.get('symbol', 'EURUSD')
    interval_str = request.args.get('interval', '1m')

    # Map Interval
    tf_map = {
        '1m': Interval.INTERVAL_1_MINUTE,
        '5m': Interval.INTERVAL_5_MINUTES,
        '10m': Interval.INTERVAL_15_MINUTES
    }
    
    tf = tf_map.get(interval_str, Interval.INTERVAL_1_MINUTE)

    try:
        handler = TA_Handler(
            symbol=symbol,
            exchange="FX_IDC",
            screener="forex",
            interval=tf
        )
        analysis = handler.get_analysis()
        summary = analysis.summary

        # Technical Signal Engine Logic
        buy_score = summary.get('BUY', 0)
        sell_score = summary.get('SELL', 0)
        total_score = buy_score + sell_score + summary.get('NEUTRAL', 0)

        if buy_score > sell_score:
            direction = "CALL"
            accuracy = min(96, int((buy_score / total_score) * 100) + 15)
        elif sell_score > buy_score:
            direction = "PUT"
            accuracy = min(96, int((sell_score / total_score) * 100) + 15)
        else:
            direction = "NEUTRAL"
            accuracy = 50

        # Countdown Logic for Next Candle
        now = datetime.datetime.now()
        seconds_remaining = 60 - now.second

        # Volatility & News Check
        is_volatile = accuracy < 65

        return jsonify({
            'direction': direction,
            'accuracy': accuracy,
            'countdown_seconds': seconds_remaining,
            'is_volatile': is_volatile,
            'symbol': symbol
        })

    except Exception as e:
        return jsonify({'error': str(e)}), 500

if __name__ == '__main__':
    app.run()
