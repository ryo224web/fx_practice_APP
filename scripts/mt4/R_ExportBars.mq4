//+------------------------------------------------------------------+
//| R_ExportBars.mq4  (Expert Advisor)                                |
//| Every hour, writes M1 bars of several symbols (up to the end of  |
//| the last finished hour) to monthly CSV files for FX Practice.    |
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
//| Output (a folder per symbol, a file per server month, server time):|
//|   fxp_bars\USDJPY\USDJPY_2026.10.csv                               |
//|     time,open,high,low,close,volume                               |
//|     2026.10.01 00:00,151.234,151.240,151.230,151.236,15           |
//|   fxp_bars\_status.csv   server time, GMT, offset, last bar ...   |
//| Every hour this month is rewritten (only the finished hours);     |
//| last month is rewritten once a day. Older months are never        |
//| touched, so they stay even after MT4 no longer has those bars.    |
//| Files are written to a temp name first and then renamed.          |
//+------------------------------------------------------------------+
#property strict
#property version     "1.02"
#property copyright   "R（FX Practice 用の自作ツール）"
#property description "FX Practice 用に、チャート（1 分足）を書き出す EA です。注文は一切出しません。"
#property description "1 時間ごと（サーバー時刻の正時を過ぎたら）、終わった 1 時間までの 1 分足を"
#property description "MQL4\\Files\\fxp_bars\\銘柄\\銘柄_年.月.csv に書きます（時刻はサーバー時刻）。"
#property description "毎時書き直すのは今月だけ、先月は 1 日 1 回。それより前の月のファイルはそのまま残します。"
#property description "このフォルダは Dropbox にあるので、Mac の FX Practice が自動で取り込みます。"

input string Symbols       = "USDJPY,EURUSD,GBPUSD,AUDUSD,USDCHF,USDCAD,NZDUSD,EURJPY,GBPJPY,XAUUSD"; // Symbols (comma separated)
input string Suffix        = "";         // Symbol suffix (empty for TitanFX)
input int    InitialMonths = 12;         // Also write this many past months (if missing)
input int    CheckEveryMin = 5;          // Check for a new hour every N minutes
input string Folder        = "fxp_bars"; // Output folder (in MQL4\Files)

string   syms[];
datetime exportedUntil = 0; // end of the last hour written (server time). 0 = not yet

int OnInit()
{
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
   EventSetTimer(MathMax(1, CheckEveryMin) * 60);
   ExportAll();
   return INIT_SUCCEEDED;
}

void OnDeinit(const int reason)
{
   EventKillTimer();
}

void OnTimer()
{
   if(Cutoff() != exportedUntil) ExportAll();
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
// 0 when MT4 has no M1 data for that period, -1 when the file could not be written.
// (error 4066 = history is being downloaded, 4073 = MT4 has no history there)
int WriteRange(string sym, datetime from, datetime to, string file, bool verbose)
{
   MqlRates rates[];
   ArraySetAsSeries(rates, false);
   ResetLastError();
   int n = CopyRates(sym, PERIOD_M1, from, to - 1, rates);
   if(n <= 0)
   {
      if(verbose) Print("R_ExportBars: no M1 data for ", sym, " ", TimeToString(from, TIME_DATE), " yet (error ", GetLastError(), "), will try again");
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
      Print("R_ExportBars: cannot write ", tmp, " error ", GetLastError());
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
      Print("R_ExportBars: cannot rename ", tmp, " error ", GetLastError());
      return -1;
   }
   return written;
}

// Writes bars before cutoff. Last month only when withLastMonth (once a day).
// Returns true when everything that should be written was written.
bool ExportSymbol(string sym, datetime cutoff, bool withLastMonth)
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
      datetime to = (datetime)MathMin(MonthStart(ny, nm), cutoff); // finished hours only
      if(to <= from) continue;                            // first hour of the month: nothing finished yet
      string file = sym + "_" + IntegerToString(yy) + "." + Two(mm) + ".csv";
      if(k == 1 && !withLastMonth) continue;
      if(k >= 2 && FileIsExist(Folder + "\\" + sym + "\\" + file)) continue;
      int n = WriteRange(sym, from, to, file, k <= 1);
      if(n > 0)
      {
         months = IntegerToString(yy) + "." + Two(mm) + (months == "" ? "" : " ") + months;
         bars += n;
      }
      else if(k <= 1) ok = false;   // this month / last month: try again at the next check
      else if(n == 0) missing++;
   }
   if(months != "")
      Print("R_ExportBars: ", sym, " wrote ", months, " (", bars, " bars)",
            missing > 0 ? ", " + IntegerToString(missing) + " older months are not in MT4" : "");
   return ok;
}

void ExportAll()
{
   datetime cutoff = Cutoff();
   // last month is rewritten once a day (and on the first run)
   bool withLastMonth = exportedUntil == 0 || DayOf(exportedUntil) != DayOf(cutoff);
   bool ok = true;
   for(int i = 0; i < ArraySize(syms); i++)
      if(!ExportSymbol(syms[i], cutoff, withLastMonth)) ok = false;
   // when MT4 was still downloading history, try again at the next check
   if(ok) exportedUntil = cutoff;

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
