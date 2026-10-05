import 'dart:async';
import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;
import 'package:url_launcher/url_launcher.dart';
import 'package:shared_preferences/shared_preferences.dart';

void main() {
  runApp(const AKPremiumBotApp());
}

class AKPremiumBotApp extends StatelessWidget {
  const AKPremiumBotApp({Key? key}) : super(key: key);

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'AK Premium Binary Bot',
      debugShowCheckedModeBanner: false,
      theme: ThemeData.dark().copyWith(
        scaffoldBackgroundColor: const Color(0xFF0F172A),
        primaryColor: const Color(0xFF6366F1),
      ),
      home: const SplashScreen(),
    );
  }
}

// ----------------------------------------------------
// 1. SPLASH / WHATSAPP VERIFICATION SCREEN
// ----------------------------------------------------
class SplashScreen extends StatefulWidget {
  const SplashScreen({Key? key}) : super(key: key);

  @override
  State<SplashScreen> createState() => _SplashScreenState();
}

class _SplashScreenState extends State<SplashScreen> {
  bool _isJoined = false;
  final String whatsappUrl = "https://chat.whatsapp.com/HOOyD7NhzWWIhAq4LRuJZt";

  @override
  void initState() {
    super.initState();
    _checkJoinStatus();
  }

  Future<void> _checkJoinStatus() async {
    final prefs = await SharedPreferences.getInstance();
    setState(() {
      _isJoined = prefs.getBool('whatsapp_joined') ?? false;
    });

    if (_isJoined) {
      _navigateToHome();
    }
  }

  void _navigateToHome() {
    Navigator.pushReplacement(
      context,
      MaterialPageRoute(builder: (context) => const HomeScreen()),
    );
  }

  Future<void> _joinWhatsApp() async {
    final Uri url = Uri.parse(whatsappUrl);
    if (await launchUrl(url, mode: LaunchMode.externalApplication)) {
      final prefs = await SharedPreferences.getInstance();
      await prefs.setBool('whatsapp_joined', true);
      setState(() {
        _isJoined = true;
      });
      _navigateToHome();
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: Center(
        child: Padding(
          padding: const EdgeInsets.all(24.0),
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              const Icon(Icons.psychology_alt, size: 80, color: Color(0xFF6366F1)),
              const SizedBox(height: 20),
              const Text(
                'AK PREMIUM BINARY BOT',
                style: TextStyle(fontSize: 22, fontWeight: FontWeight.bold, letterSpacing: 1.2),
              ),
              const SizedBox(height: 10),
              const Text(
                'To access premium signals, you must join our official WhatsApp Channel first.',
                textAlign: TextAlign.center,
                style: TextStyle(color: Colors.grey),
              ),
              const SizedBox(height: 40),
              ElevatedButton.icon(
                style: ElevatedButton.styleFrom(
                  backgroundColor: const Color(0xFF25D366),
                  padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 14),
                  shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
                ),
                onPressed: _joinWhatsApp,
                icon: const Icon(Icons.group_add, color: Colors.white),
                label: const Text('Join WhatsApp Channel to Unlock', style: TextStyle(color: Colors.white, fontSize: 16)),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

// ----------------------------------------------------
// 2. MAIN DASHBOARD SCREEN
// ----------------------------------------------------
class HomeScreen extends StatefulWidget {
  const HomeScreen({Key? key}) : super(key: key);

  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> {
  final List<String> pairs = [
    "EURUSD", "GBPUSD", "USDJPY", "USDCHF", "USDCAD",
    "AUDUSD", "NZDUSD", "EURGBP", "EURJPY", "GBPJPY"
  ];
  
  String selectedPair = "EURUSD";
  String selectedTF = "1m";
  
  bool isLoading = false;
  Map<String, dynamic>? signalData;
  Timer? countdownTimer;
  int secondsRemaining = 0;

  // Daily Stats Tracker
  int totalTrades = 0;
  int wins = 0;
  int losses = 0;

  @override
  void initState() {
    super.initState();
    _loadDailyStats();
    _fetchSignal();
  }

  @override
  void dispose() {
    countdownTimer?.cancel();
    super.dispose();
  }

  // --- Daily Stats & Midnight PKT Reset Logic ---
  Future<void> _loadDailyStats() async {
    final prefs = await SharedPreferences.getInstance();
    String lastDate = prefs.getString('last_trade_date') ?? '';
    
    // Get current date in PKT
    DateTime nowPkt = DateTime.now().toUtc().add(const Duration(hours: 5));
    String todayStr = "${nowPkt.year}-${nowPkt.month}-${nowPkt.day}";

    if (lastDate != todayStr) {
      // Auto-reset stats at 12:00 AM PKT
      await prefs.setString('last_trade_date', todayStr);
      await prefs.setInt('total_trades', 0);
      await prefs.setInt('wins', 0);
      await prefs.setInt('losses', 0);
      setState(() {
        totalTrades = 0;
        wins = 0;
        losses = 0;
      });
    } else {
      setState(() {
        totalTrades = prefs.getInt('total_trades') ?? 0;
        wins = prefs.getInt('wins') ?? 0;
        losses = prefs.getInt('losses') ?? 0;
      });
    }
  }

  Future<void> _updateStats(bool isWin) async {
    final prefs = await SharedPreferences.getInstance();
    setState(() {
      totalTrades++;
      if (isWin) {
        wins++;
      } else {
        losses++;
      }
    });

    await prefs.setInt('total_trades', totalTrades);
    await prefs.setInt('wins', wins);
    await prefs.setInt('losses', losses);
  }

  // --- Fetch Signal API ---
  Future<void> _fetchSignal() async {
    setState(() {
      isLoading = true;
    });

    // API Query Parameters Corrected: symbol & interval
    final url = Uri.parse('https://akprimiumebot.pythonanywhere.com/signal?symbol=$selectedPair&interval=$selectedTF');

    try {
      final response = await http.get(url);
      if (response.statusCode == 200) {
        final data = json.decode(response.body);
        setState(() {
          signalData = data;
          secondsRemaining = data['countdown_seconds'] ?? 0;
          isLoading = false;
        });

        _startCountdown();

        // Check for Volatility Warning
        if (data['is_volatile'] == true && data['warning'] != null) {
          _showVolatilityDialog(data['warning']);
        }
      } else {
        setState(() {
          isLoading = false;
          signalData = null;
        });
      }
    } catch (e) {
      setState(() {
        isLoading = false;
        signalData = null;
      });
    }
  }

  void _startCountdown() {
    countdownTimer?.cancel();
    countdownTimer = Timer.periodic(const Duration(seconds: 1), (timer) {
      if (secondsRemaining > 0) {
        setState(() {
          secondsRemaining--;
        });
      } else {
        timer.cancel();
        _fetchSignal(); // Auto refresh on new candle
      }
    });
  }

  void _showVolatilityDialog(String warningText) {
    showDialog(
      context: context,
      barrierDismissible: false,
      builder: (context) => AlertDialog(
        backgroundColor: const Color(0xFF1E293B),
        title: Row(
          children: const [
            Icon(Icons.warning_amber_rounded, color: Colors.orange, size: 28),
            SizedBox(width: 8),
            Text('Market Volatility Alert', style: TextStyle(color: Colors.white)),
          ],
        ),
        content: Text(
          '$warningText\nAccuracy is below 60%. Trading is highly risky right now.',
          style: const TextStyle(color: Colors.grey),
        ),
        actions: [
          ElevatedButton(
            style: ElevatedButton.styleFrom(backgroundColor: Colors.orange),
            onPressed: () => Navigator.pop(context),
            child: const Text('I Understand', style: TextStyle(color: Colors.white)),
          )
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('AK Premium Bot Dashboard', style: TextStyle(fontSize: 18)),
        backgroundColor: const Color(0xFF1E293B),
        elevation: 0,
      ),
      body: SingleChildScrollView(
        padding: const EdgeInsets.all(16.0),
        child: Column(
          children: [
            // --- DAILY PERFORMANCE TRACKER BOARD ---
            Container(
              padding: const EdgeInsets.all(16),
              decoration: BoxDecoration(
                color: const Color(0xFF1E293B),
                borderRadius: BorderRadius.circular(16),
                border: Border.all(color: Colors.white10),
              ),
              child: Column(
                children: [
                  const Text('Today\'s Performance (Resets 12:00 AM PKT)', style: TextStyle(color: Colors.grey, fontSize: 12)),
                  const SizedBox(height: 12),
                  Row(
                    mainAxisAlignment: MainAxisAlignment.spaceAround,
                    children: [
                      _buildStatItem('Total', '$totalTrades', Colors.blue),
                      _buildStatItem('Wins', '$wins', Colors.green),
                      _buildStatItem('Losses', '$losses', Colors.red),
                      _buildStatItem('Win Rate', totalTrades > 0 ? '${((wins/totalTrades)*100).toStringAsFixed(0)}%' : '0%', Colors.amber),
                    ],
                  ),
                ],
              ),
            ),

            const SizedBox(height: 20),

            // --- PAIR & TIMEFRAME SELECTORS ---
            Row(
              children: [
                Expanded(
                  child: Container(
                    padding: const EdgeInsets.symmetric(horizontal: 12),
                    decoration: BoxDecoration(
                      color: const Color(0xFF1E293B),
                      borderRadius: BorderRadius.circular(12),
                    ),
                    child: DropdownButtonHideUnderline(
                      child: DropdownButton<String>(
                        value: selectedPair,
                        dropdownColor: const Color(0xFF1E293B),
                        isExpanded: true,
                        items: pairs.map((pair) {
                          return DropdownMenuItem(value: pair, child: Text(pair));
                        }).toList(),
                        onChanged: (val) {
                          if (val != null) {
                            setState(() => selectedPair = val);
                            _fetchSignal();
                          }
                        },
                      ),
                    ),
                  ),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: Container(
                    padding: const EdgeInsets.symmetric(horizontal: 12),
                    decoration: BoxDecoration(
                      color: const Color(0xFF1E293B),
                      borderRadius: BorderRadius.circular(12),
                    ),
                    child: DropdownButtonHideUnderline(
                      child: DropdownButton<String>(
                        value: selectedTF,
                        dropdownColor: const Color(0xFF1E293B),
                        isExpanded: true,
                        items: const [
                          DropdownMenuItem(value: "1m", child: Text("1 Minute")),
                          DropdownMenuItem(value: "5m", child: Text("5 Minutes")),
                          DropdownMenuItem(value: "10m", child: Text("10 Minutes")),
                        ],
                        onChanged: (val) {
                          if (val != null) {
                            setState(() => selectedTF = val);
                            _fetchSignal();
                          }
                        },
                      ),
                    ),
                  ),
                ),
              ],
            ),

            const SizedBox(height: 20),

            // --- SIGNAL DISPLAY CARD ---
            isLoading
                ? const CircularProgressIndicator()
                : signalData == null
                    ? const Text('Failed to load signal data')
                    : Container(
                        padding: const EdgeInsets.all(20),
                        decoration: BoxDecoration(
                          color: const Color(0xFF1E293B),
                          borderRadius: BorderRadius.circular(20),
                          border: Border.all(
                            color: (signalData!['direction'] ?? '').toString().contains('CALL')
                                ? Colors.green
                                : ((signalData!['direction'] ?? '').toString().contains('PUT') ? Colors.red : Colors.grey),
                            width: 2,
                          ),
                        ),
                        child: Column(
                          children: [
                            Text(
                              'Accuracy Score: ${signalData!['accuracy'] ?? 0}%',
                              style: TextStyle(
                                fontSize: 18,
                                fontWeight: FontWeight.bold,
                                color: (signalData!['accuracy'] as num? ?? 0) >= 60 ? Colors.greenAccent : Colors.orangeAccent,
                              ),
                            ),
                            const Divider(height: 20, color: Colors.white10),
                            Text(
                              signalData!['direction'] ?? 'NEUTRAL',
                              style: TextStyle(
                                fontSize: 28,
                                fontWeight: FontWeight.bold,
                                color: (signalData!['direction'] ?? '').toString().contains('CALL') ? Colors.green : Colors.red,
                              ),
                            ),
                            const SizedBox(height: 12),
                            Text(
                              'Next Candle Entry: ${signalData!['next_candle'] ?? 'N/A'}',
                              style: const TextStyle(color: Colors.white70),
                            ),
                            const SizedBox(height: 8),
                            Container(
                              padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
                              decoration: BoxDecoration(
                                color: Colors.indigo.withOpacity(0.3),
                                borderRadius: BorderRadius.circular(20),
                              ),
                              child: Text(
                                'Candle Starts In: ${secondsRemaining}s',
                                style: const TextStyle(fontWeight: FontWeight.bold, color: Colors.indigoAccent),
                              ),
                            ),
                          ],
                        ),
                      ),

            const SizedBox(height: 24),

            // --- TRADE RESULT BUTTONS ---
            const Text('Mark Result After Trade Ends:', style: TextStyle(color: Colors.grey)),
            const SizedBox(height: 12),
            Row(
              children: [
                Expanded(
                  child: ElevatedButton.icon(
                    style: ElevatedButton.styleFrom(
                      backgroundColor: Colors.green,
                      padding: const EdgeInsets.symmetric(vertical: 14),
                      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
                    ),
                    onPressed: () => _updateStats(true),
                    icon: const Icon(Icons.check_circle, color: Colors.white),
                    label: const Text('WIN', style: TextStyle(color: Colors.white, fontWeight: FontWeight.bold)),
                  ),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: ElevatedButton.icon(
                    style: ElevatedButton.styleFrom(
                      backgroundColor: Colors.red,
                      padding: const EdgeInsets.symmetric(vertical: 14),
                      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
                    ),
                    onPressed: () => _updateStats(false),
                    icon: const Icon(Icons.cancel, color: Colors.white),
                    label: const Text('LOSS', style: TextStyle(color: Colors.white, fontWeight: FontWeight.bold)),
                  ),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildStatItem(String label, String value, Color color) {
    return Column(
      children: [
        Text(value, style: TextStyle(fontSize: 18, fontWeight: FontWeight.bold, color: color)),
        const SizedBox(height: 4),
        Text(label, style: const TextStyle(fontSize: 12, color: Colors.grey)),
      ],
    );
  }
}
