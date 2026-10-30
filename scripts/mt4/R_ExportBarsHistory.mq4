//+------------------------------------------------------------------+
//| R_ExportBarsHistory.mq4  (Expert Advisor)                         |
//| Writes M1 bars of several symbols to CSV files for FX Practice   |
//| (monthly files once a day, today's file every hour), and sends   |
//| the current prices to FX Practice on the Mac every 0.25 s.        |
//| FX Practice (on the Mac) watches the folder and imports them.    |
//|                                                                    |
//| Kept as UTF-8 in git; npm run deploy-mt4 copies it to the MT4     |
//| data folder as UTF-16 (MetaEditor reads Japanese correctly then). |
//| Japanese instructions: see CLAUDE.md ("MT4 1-minute bars").       |
//|                                                                    |
//| 1. Put this file in <data folder>\MQL4\Experts and compile it.   |
//| 2. The MT4 data folder itself is in Dropbox (Dropbox\MT4), so   |
//|    the output reaches the Mac without any extra setup.            |
//| 3. Attach the EA to any one chart. AutoTrading is NOT needed      |
//|    (this EA never trades).                                         |
//|                                                                    |
//| Output (a folder per symbol, server time):                         |
//|   fxp_bars\USDJPY\USDJPY_2026.10.csv     a server month            |
//|   fxp_bars\USDJPY\USDJPY_2026.10.30.csv  today (until it is in     |
//|                                           the month file)          |
//|     time,open,high,low,close,volume                               |
//|     2026.10.01 00:00,151.234,151.240,151.230,151.236,15           |
//|   fxp_bars\_status.csv   server time, GMT, offset, last bar ...   |
//| Once a day this month and last month are rewritten up to the end  |
//| of yesterday; every hour only today's file is rewritten (small,   |
//| so Dropbox has little to sync). Day files older than 2 days are   |
//| deleted (they are in the month file). Older months are never      |
//| touched, so they stay even after MT4 no longer has those bars.    |
//| Files are written to a temp name first and then renamed.          |
//|                                                                    |
//| Every SendEveryMs (0.25 s) it sends the prices and last M1 bars to|
//| LiveUrl (FX Practice on the Mac, not through Dropbox). Allow the  |
//| URL once: Tools -> Options -> Expert Advisors -> "Allow WebRequest |
//| for listed URL" -> add http://<the Mac>.                           |
//| While sending fails, every minute it writes the last LiveMinutes  |
//| finished M1 bars to fxp_bars\USDJPY\USDJPY_live.csv instead.      |
//|                                                                    |
//| Also writes the account history (closed trades and open positions)|
//| to MQL4\Files\fx_practice_history.csv (same format as           |
//| R_ExportHistory) when the EA starts and whenever a trade opens or |
//| closes (checked every CheckEveryMin minutes).                     |
//| Only the period shown in the Account History tab can be read, so  |
//| set it to "All History" once (right click -> All History).        |
//+------------------------------------------------------------------+
#property strict
#property version     "1.09"
#property copyright   "R（FX Practice 用の自作ツール）"
#property description "FX Practice 用に、チャート（1 分足）を書き出す EA です。注文は一切出しません。"
#property description "1 分足を MQL4\\Files\\fxp_bars\\銘柄\\ に書きます（時刻はサーバー時刻）。月ごとのファイル（銘柄_年.月.csv）は"
#property description "1 日 1 回（昨日まで）、今日のファイル（銘柄_年.月.日.csv）は 1 時間ごと。古い月のファイルはそのまま残します。"
#property description "このフォルダは Dropbox にあるので、Mac の FX Practice が自動で取り込みます。"
#property description "0.25 秒ごと（SendEveryMs）に今の価格を Mac の FX Practice へ直接送ります（ライブ用。LiveUrl を「WebRequest を許可する URL」に入れる）。"
#property description "取引履歴も、起動したときと取引を建てた・決済したときに MQL4\\Files\\fx_practice_history.csv に書きます（口座履歴タブを「全履歴」にしておく）。"

input string Symbols       = "USDJPY,EURUSD,GBPUSD,AUDUSD,USDCHF,USDCAD,NZDUSD,EURJPY,GBPJPY,XAUUSD,BTCUSD,JPN225"; // Symbols (comma separated)
input string Suffix        = "";         // Symbol suffix (empty for TitanFX)
input int    InitialMonths = 12;         // Also write this many past months (if missing)
input int    CheckEveryMin = 1;          // Check for a new hour / new trades every N minutes
input string LiveUrl       = "http://192.168.40.227/fxp/tick"; // Send the prices to FX Practice on the Mac (empty = off)
input int    SendEveryMs   = 250;        // Send the prices every N milliseconds (only when they changed)
input int    LiveMinutes   = 120;        // While sending fails, write the last N finished M1 bars to <symbol>_live.csv every minute (0 = off)
input string Folder        = "fxp_bars"; // Output folder (in MQL4\Files)
input string HistoryFile   = "fx_practice_history.csv"; // Account history file (in MQL4\Files). Empty = do not write

string   syms[];
datetime exportedUntil = 0; // end of the last hour written (server time). 0 = not yet
string   historySig = "";    // number of closed / open trades when the history was last written
datetime liveUntil = 0;     // end of the last minute written to the _live.csv files (server time)
datetime monthsDay = 0;     // the day the month files were last written (server time)
bool     sendOk = false;    // the last send to LiveUrl worked
string   sentBody = "";     // the last body sent (nothing is sent while the prices do not change)
uint     startedAt = 0;     // GetTickCount when the EA started
int      sendCount = 0;     // sends and their time in this minute (printed for the first 5 minutes)
uint     sendMs = 0;
uint     sendMaxMs = 0;
uint     catchUpUntil = 0;  // for 10 minutes after sending starts (again), today's bars are also sent once a minute
uint     catchUpAt = 0;     // GetTickCount of the last catch-up send
uint     retryAt = 0;       // after a failed send, try again at this GetTickCount
uint     minuteAt = 0;      // GetTickCount of the last check (new hour, new trades)
bool     urlWarned = false;

int OnInit()
{
   historySig = "";
   string parts[];
   int n = StringSplit(Symbols, ',', parts);
   ArrayResize(syms, 0);
   for(int i = 0; i < n; i++)
   {
      string s = parts[i];
      StringTrimLeft(s);
      StringTrimRight(s);
      if(s == "") continue;
      int k = ArraySize(syms);
      ArrayResize(syms, k + 1);
      syms[k] = s + Suffix;
      SymbolSelect(syms[k], true); // show it in Market Watch so MT4 keeps its history
   }
   liveUntil = 0;
   monthsDay = 0;
   sendOk = false;
   sentBody = "";
   retryAt = 0;
   startedAt = GetTickCount();
   sendCount = 0;
   sendMs = 0;
   sendMaxMs = 0;
   if(LiveUrl != "") EventSetMillisecondTimer(MathMax(100, SendEveryMs));
   else EventSetTimer(60);
   ExportAll();
   ExportLive();
   ExportHistory();
   minuteAt = GetTickCount();
   return INIT_SUCCEEDED;
}

void OnDeinit(const int reason)
{
   EventKillTimer();
}

void OnTimer()
{
   SendLive();
   if(GetTickCount() - minuteAt < (uint)MathMax(1, CheckEveryMin) * 60000 - 2000) return;
   minuteAt = GetTickCount();
   if(sendCount > 0 && GetTickCount() - startedAt < 6 * 60000)
      Print("R_ExportBarsHistory: sent ", sendCount, " times in the last minute (", sendMs / sendCount, " ms on average, ", sendMaxMs, " ms at most)");
   sendCount = 0;
   sendMs = 0;
   sendMaxMs = 0;
   if(Cutoff() != exportedUntil) ExportAll();
   ExportLive();
   if(HistorySig() != historySig) ExportHistory();
}

// ---------------- prices every SendEveryMs, straight to the Mac (not through Dropbox) ----------------
// Body (text, one line each, times are server time in seconds):
//   Q,<symbol>,<server time>,<bid>,<ask>
//   B,<symbol>,<bar time>,<open>,<high>,<low>,<close>   the last 3 M1 bars, the last one is still forming
// For 10 minutes after sending starts (when the EA starts, or the Mac answers again), once a minute all of
// today's bars are sent instead of the last 3, so that the bars from while T580 / MT4 / the Mac was off reach
// the Mac at once (MT4 downloads them from the broker a little after it starts, so this is repeated).
// Nothing is sent while the prices do not change (e.g. on weekends).
// (TimeCurrent is not used for this: inside the EA it does not move every second.)
void SendLive()
{
   if(LiveUrl == "") return;
   if(!sendOk && retryAt != 0 && GetTickCount() < retryAt) return;
   RefreshRates();
   bool catchUp = catchUpUntil != 0 && GetTickCount() < catchUpUntil && GetTickCount() - catchUpAt >= 60000;
   datetime today = DayOf(TimeCurrent());
   string body = "";
   for(int i = 0; i < ArraySize(syms); i++)
   {
      string sym = syms[i];
      int digits = (int)MarketInfo(sym, MODE_DIGITS);
      if(digits <= 0) digits = 5;
      double bid = MarketInfo(sym, MODE_BID);
      if(bid <= 0) continue;
      body += "Q," + sym + "," + IntegerToString((long)MarketInfo(sym, MODE_TIME)) + "," +
              DoubleToString(bid, digits) + "," + DoubleToString(MarketInfo(sym, MODE_ASK), digits) + "\n";
      MqlRates r[];
      ArraySetAsSeries(r, false);
      int n = catchUp ? CopyRates(sym, PERIOD_M1, today, TimeCurrent(), r) : CopyRates(sym, PERIOD_M1, 0, 3, r);
      for(int j = 0; j < n; j++)
         body += "B," + sym + "," + IntegerToString((long)r[j].time) + "," + DoubleToString(r[j].open, digits) + "," +
                 DoubleToString(r[j].high, digits) + "," + DoubleToString(r[j].low, digits) + "," + DoubleToString(r[j].close, digits) + "\n";
   }
   if(body == "" || (body == sentBody && sendOk && !catchUp)) return;
   char data[];
   char result[];
   string headers;
   StringToCharArray(body, data, 0, StringLen(body));
   ResetLastError();
   uint t0 = GetTickCount();
   int code = WebRequest("POST", LiveUrl, "Content-Type: text/plain\r\n", catchUp ? 5000 : 500, data, result, headers);
   uint ms = GetTickCount() - t0;
   bool ok = code == 200;
   if(ok)
   {
      sendCount++;
      sendMs += ms;
      if(ms > sendMaxMs) sendMaxMs = ms;
   }
   if(!ok)
   {
      int err = GetLastError();
      if(err == 4060 && !urlWarned)
      {
         Print("R_ExportBarsHistory: add ", LiveUrl, " to Tools -> Options -> Expert Advisors -> Allow WebRequest for listed URL");
         urlWarned = true;
      }
      else if(sendOk) Print("R_ExportBarsHistory: cannot send to ", LiveUrl, " (", code, ", error ", err, "), will try again every 30 s");
      retryAt = GetTickCount() + 30000;
   }
   else if(!sendOk)
   {
      Print("R_ExportBarsHistory: sending prices to ", LiveUrl);
      catchUpUntil = GetTickCount() + 10 * 60000;
      catchUpAt = 0;   // today's bars at the next send
   }
   if(ok && catchUp) catchUpAt = GetTickCount();
   sendOk = ok;
   sentBody = body;
}

// While the prices cannot be sent: every minute, the last LiveMinutes finished M1 bars of each symbol to <symbol>_live.csv.
// Nothing is written while the minute has not changed (e.g. on weekends, when TimeCurrent stops).
void ExportLive()
{
   if(LiveMinutes <= 0 || sendOk) return;
   datetime now = TimeCurrent();
   datetime to = now - now % 60;   // the start of the current minute: bars before it are finished
   if(to == liveUntil) return;
   bool ok = true;
   for(int i = 0; i < ArraySize(syms); i++)
      if(WriteRange(syms[i], to - LiveMinutes * 60, to, syms[i] + "_live.csv", false) < 0) ok = false;
   if(ok) liveUntil = to;
}

void OnTick() {}

// The start of the current server hour: bars before it are finished.
// (On weekends TimeCurrent stops at the last tick, so nothing is written again.)
datetime Cutoff()
{
   datetime now = TimeCurrent();
   return now - now % 3600;
}

datetime DayOf(datetime t) { return t - t % 86400; }

string Two(int v) { return (v < 10 ? "0" : "") + IntegerToString(v); }

datetime MonthStart(int year, int month)
{
   return StrToTime(IntegerToString(year) + "." + Two(month) + ".01 00:00");
}

// Writes the bars of [from, to) to file. Returns the number of bars written,
// 0 when MT4 has no M1 data for that period, -1 when the file could not be written,
// -2 while MT4 is still downloading that history (try again later).
// (error 4066 = history is being downloaded, 4073 = MT4 has no history there)
int WriteRange(string sym, datetime from, datetime to, string file, bool verbose)
{
   MqlRates rates[];
   ArraySetAsSeries(rates, false);
   ResetLastError();
   int n = CopyRates(sym, PERIOD_M1, from, to - 1, rates);
   if(n <= 0)
   {
      int err = GetLastError();
      if(err == 4066)
      {
         if(verbose) Print("R_ExportBarsHistory: M1 data for ", sym, " ", TimeToString(from, TIME_DATE), " is being downloaded, will try again");
         return -2;
      }
      if(verbose) Print("R_ExportBarsHistory: no M1 data for ", sym, " ", TimeToString(from, TIME_DATE), " in MT4 (error ", err, ")");
      return 0;
   }
   int digits = (int)MarketInfo(sym, MODE_DIGITS);
   if(digits <= 0) digits = 5;
   string dir = Folder + "\\" + sym;
   FolderCreate(dir);
   string tmp = dir + "\\" + file + ".tmp";
   string dst = dir + "\\" + file;
   int f = FileOpen(tmp, FILE_WRITE | FILE_TXT | FILE_ANSI);
   if(f == INVALID_HANDLE)
   {
      Print("R_ExportBarsHistory: cannot write ", tmp, " error ", GetLastError());
      return -1;
   }
   int written = 0;
   FileWriteString(f, "time,open,high,low,close,volume\r\n");
   for(int i = 0; i < n; i++)
   {
      if(rates[i].time < from || rates[i].time >= to) continue;
      written++;
      FileWriteString(f, TimeToString(rates[i].time, TIME_DATE | TIME_MINUTES) + "," +
                         DoubleToString(rates[i].open, digits) + "," +
                         DoubleToString(rates[i].high, digits) + "," +
                         DoubleToString(rates[i].low, digits) + "," +
                         DoubleToString(rates[i].close, digits) + "," +
                         IntegerToString((int)rates[i].tick_volume) + "\r\n");
   }
   FileClose(f);
   if(written == 0)
   {
      // no bar inside the month: do not leave an empty file (it would never be retried)
      FileDelete(tmp);
      return 0;
   }
   if(!FileMove(tmp, 0, dst, FILE_REWRITE))
   {
      Print("R_ExportBarsHistory: cannot rename ", tmp, " error ", GetLastError());
      return -1;
   }
   return written;
}

// Writes bars before cutoff (the start of today) to the month files: this month and last month
// only when withMonths (once a day), older months only when their file is missing.
// Returns true when everything that should be written was written.
bool ExportMonths(string sym, datetime cutoff, bool withMonths)
{
   bool ok = true;
   string months = "";   // months written this time
   int bars = 0;
   int missing = 0;      // older months MT4 does not have
   int y = TimeYear(cutoff);
   int m = TimeMonth(cutoff);
   // k = 0: this month, 1: last month, 2..: older months (only if their file is missing)
   for(int k = 0; k <= MathMax(1, InitialMonths); k++)
   {
      int yy = y;
      int mm = m - k;
      while(mm <= 0) { mm += 12; yy--; }
      datetime from = MonthStart(yy, mm);
      int ny = mm == 12 ? yy + 1 : yy;
      int nm = mm == 12 ? 1 : mm + 1;
      datetime to = (datetime)MathMin(MonthStart(ny, nm), cutoff); // finished days only
      if(to <= from) continue;                            // first day of the month: nothing finished yet
      string file = sym + "_" + IntegerToString(yy) + "." + Two(mm) + ".csv";
      if(k <= 1 && !withMonths) continue;
      if(k >= 2 && FileIsExist(Folder + "\\" + sym + "\\" + file)) continue;
      int n = WriteRange(sym, from, to, file, k <= 1);
      if(n > 0)
      {
         months = IntegerToString(yy) + "." + Two(mm) + (months == "" ? "" : " ") + months;
         bars += n;
      }
      // this month / last month: try again at the next check only when MT4 was still downloading or the file
      // could not be written (when MT4 simply does not have that month, trying every minute only rewrites
      // the other files again and again)
      else if(k <= 1 && n < 0) ok = false;
      else if(n == 0) missing++;
   }
   if(months != "")
      Print("R_ExportBarsHistory: ", sym, " wrote ", months, " (", bars, " bars)",
            missing > 0 ? ", " + IntegerToString(missing) + " older months are not in MT4" : "");
   return ok;
}

string DayFile(string sym, datetime day)
{
   return sym + "_" + IntegerToString(TimeYear(day)) + "." + Two(TimeMonth(day)) + "." + Two(TimeDay(day)) + ".csv";
}

void ExportAll()
{
   datetime cutoff = Cutoff();
   datetime today = DayOf(cutoff);
   // the month files once a day (up to the end of yesterday), and on the first run
   bool withMonths = monthsDay != today;
   bool ok = true;
   bool monthsOk = true;
   for(int i = 0; i < ArraySize(syms); i++)
   {
      string sym = syms[i];
      if(!ExportMonths(sym, today, withMonths)) monthsOk = false;
      // today's file: the finished hours of today (nothing in the first hour of the day)
      if(cutoff > today && WriteRange(sym, today, cutoff, DayFile(sym, today), false) < 0) ok = false;
      // yesterday's file is kept one more day; older ones are already in the month file
      if(withMonths && monthsOk)
         for(int d = 2; d <= 10; d++)
         {
            string old = Folder + "\\" + sym + "\\" + DayFile(sym, today - d * 86400);
            if(FileIsExist(old)) FileDelete(old);
         }
   }
   // when MT4 was still downloading history, try again at the next check
   if(monthsOk) monthsDay = today;
   if(ok && monthsOk) exportedUntil = cutoff;

   // Status: lets FX Practice check the server time zone (offset = server - GMT, in seconds)
   datetime now = TimeCurrent();
   int f = FileOpen(Folder + "\\_status.tmp", FILE_WRITE | FILE_TXT | FILE_ANSI);
   if(f == INVALID_HANDLE) return;
   FileWriteString(f, "server,gmt,offset_sec,company,server_name,exported_until\r\n");
   FileWriteString(f, TimeToString(now, TIME_DATE | TIME_SECONDS) + "," +
                      TimeToString(TimeGMT(), TIME_DATE | TIME_SECONDS) + "," +
                      IntegerToString((int)(now - TimeGMT())) + "," +
                      AccountCompany() + "," + AccountServer() + "," +
                      TimeToString(cutoff, TIME_DATE | TIME_MINUTES) + "\r\n");
   FileClose(f);
   FileMove(Folder + "\\_status.tmp", 0, Folder + "\\_status.csv", FILE_REWRITE);
}

// ---------------- account history (same format as R_ExportHistory) ----------------

// Changes when a trade opens or closes, a pending order is filled or deleted,
// or the period of the Account History tab is changed. (A closed trade never changes;
// the S/L and T/P of a position are written as they were when it closed.)
string HistorySig()
{
   return IntegerToString(OrdersHistoryTotal()) + "/" + IntegerToString(OrdersTotal());
}

string HPrice(string symbol, double p)
{
   if(p <= 0) return "0";
   int digits = (int)MarketInfo(symbol, MODE_DIGITS);
   if(digits <= 0) digits = 5;
   return DoubleToString(p, digits);
}

string HTime(datetime t)
{
   if(t <= 0) return "";
   return TimeToString(t, TIME_DATE | TIME_SECONDS);
}

void WriteOrder(int f, bool closed)
{
   int type = OrderType();
   if(type != OP_BUY && type != OP_SELL) return;
   string symbol = OrderSymbol();
   string comment = OrderComment();
   StringReplace(comment, ",", " ");
   StringReplace(comment, "\n", " ");
   FileWriteString(f, IntegerToString(OrderTicket()) + "," +
                      HTime(OrderOpenTime()) + "," +
                      (type == OP_BUY ? "buy" : "sell") + "," +
                      DoubleToString(OrderLots(), 2) + "," +
                      symbol + "," +
                      HPrice(symbol, OrderOpenPrice()) + "," +
                      HPrice(symbol, OrderStopLoss()) + "," +
                      HPrice(symbol, OrderTakeProfit()) + "," +
                      (closed ? HTime(OrderCloseTime()) : "") + "," +
                      (closed ? HPrice(symbol, OrderClosePrice()) : "") + "," +
                      DoubleToString(OrderCommission(), 2) + "," +
                      DoubleToString(OrderSwap(), 2) + "," +
                      DoubleToString(OrderProfit(), 2) + "," +
                      comment + "\r\n");
}

// Rewrites the whole file (closed trades shown in the Account History tab + open positions)
void ExportHistory()
{
   if(HistoryFile == "") return;
   string sig = HistorySig();
   string tmp = HistoryFile + ".tmp";
   int f = FileOpen(tmp, FILE_WRITE | FILE_TXT | FILE_ANSI);
   if(f == INVALID_HANDLE)
   {
      Print("R_ExportBarsHistory: cannot write ", tmp, " error ", GetLastError());
      return;
   }
   FileWriteString(f, "ticket,open_time,type,lots,symbol,open_price,sl,tp,close_time,close_price,commission,swap,profit,comment\r\n");
   for(int i = 0; i < OrdersHistoryTotal(); i++)
      if(OrderSelect(i, SELECT_BY_POS, MODE_HISTORY)) WriteOrder(f, true);
   for(int i = 0; i < OrdersTotal(); i++)
      if(OrderSelect(i, SELECT_BY_POS, MODE_TRADES)) WriteOrder(f, false);
   FileClose(f);
   if(!FileMove(tmp, 0, HistoryFile, FILE_REWRITE))
   {
      Print("R_ExportBarsHistory: cannot rename ", tmp, " error ", GetLastError());
      return;
   }
   if(sig != historySig) Print("R_ExportBarsHistory: wrote ", HistoryFile, " (", sig, " closed/open)");
   historySig = sig;
}
