//+------------------------------------------------------------------+
//| ExportBars.mq4  (Expert Advisor)                                  |
//| Once a day, writes M1 bars of several symbols (up to the end of  |
//| the previous server day) to monthly CSV files for FX Practice.   |
//| FX Practice (on the Mac) watches the folder and imports them.    |
//|                                                                    |
//| This file is ASCII only on purpose: MetaEditor may misread UTF-8. |
//| Japanese instructions: see CLAUDE.md ("MT4 1-minute bars").       |
//|                                                                    |
//| 1. Put this file in <data folder>\MQL4\Experts and compile it.   |
//| 2. Make <data folder>\MQL4\Files\fxp_bars point to the shared    |
//|    (Dropbox) folder with a junction (mklink /J).                  |
//| 3. Attach the EA to any one chart. AutoTrading is NOT needed      |
//|    (this EA never trades).                                         |
//|                                                                    |
//| Output (a folder per symbol, a file per server month, server time):|
//|   fxp_bars\USDJPY\USDJPY_2026.10.csv                               |
//|     time,open,high,low,close,volume                               |
//|     2026.10.01 00:00,151.234,151.240,151.230,151.236,15           |
//|   fxp_bars\_status.csv   server time, GMT, offset, last bar ...   |
//| Each day only this month and last month are rewritten (only the   |
//| finished days). Older months are never touched, so they stay as  |
//| an archive even after MT4 no longer has those bars.               |
//| Files are written to a temp name first and then renamed.          |
//+------------------------------------------------------------------+
#property strict

input string Symbols       = "USDJPY,EURUSD,GBPUSD,AUDUSD,USDCHF,USDCAD,NZDUSD,EURJPY,GBPJPY,XAUUSD";
input string Suffix        = "";   // e.g. ".a" if the broker adds one
input int    InitialMonths = 3;    // on the first run, also write this many past months if their files do not exist
input int    CheckEveryMin = 30;   // how often to check whether a new day has started
input string Folder        = "fxp_bars";

string   syms[];
datetime exportedDay = 0;   // server day (00:00) of the last export

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
   if(Today() != exportedDay) ExportAll();
}

void OnTick() {}

datetime Today()
{
   datetime now = TimeCurrent();
   return now - now % 86400;
}

string Two(int v) { return (v < 10 ? "0" : "") + IntegerToString(v); }

datetime MonthStart(int year, int month)
{
   return StrToTime(IntegerToString(year) + "." + Two(month) + ".01 00:00");
}

// Writes the bars of [from, to) to file. Returns false when MT4 has no data (yet).
bool WriteRange(string sym, datetime from, datetime to, string file)
{
   MqlRates rates[];
   ArraySetAsSeries(rates, false);
   ResetLastError();
   int n = CopyRates(sym, PERIOD_M1, from, to - 1, rates);
   if(n <= 0)
   {
      // 4066 = history is being downloaded; the next check will try again
      Print("ExportBars: no M1 data for ", sym, " ", TimeToString(from, TIME_DATE), " (error ", GetLastError(), ")");
      return false;
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
      Print("ExportBars: cannot write ", tmp, " error ", GetLastError());
      return false;
   }
   FileWriteString(f, "time,open,high,low,close,volume\r\n");
   for(int i = 0; i < n; i++)
   {
      if(rates[i].time < from || rates[i].time >= to) continue;
      FileWriteString(f, TimeToString(rates[i].time, TIME_DATE | TIME_MINUTES) + "," +
                         DoubleToString(rates[i].open, digits) + "," +
                         DoubleToString(rates[i].high, digits) + "," +
                         DoubleToString(rates[i].low, digits) + "," +
                         DoubleToString(rates[i].close, digits) + "," +
                         IntegerToString((int)rates[i].tick_volume) + "\r\n");
   }
   FileClose(f);
   if(!FileMove(tmp, 0, dst, FILE_REWRITE))
   {
      Print("ExportBars: cannot rename ", tmp, " error ", GetLastError());
      return false;
   }
   return true;
}

// Returns true when everything that should be written was written.
bool ExportSymbol(string sym, datetime today)
{
   bool ok = true;
   int y = TimeYear(today);
   int m = TimeMonth(today);
   // k = 0: this month, 1: last month, 2..: older months (only if their file is missing)
   for(int k = 0; k <= MathMax(1, InitialMonths); k++)
   {
      int yy = y;
      int mm = m - k;
      while(mm <= 0) { mm += 12; yy--; }
      datetime from = MonthStart(yy, mm);
      int ny = mm == 12 ? yy + 1 : yy;
      int nm = mm == 12 ? 1 : mm + 1;
      datetime to = (datetime)MathMin(MonthStart(ny, nm), today); // finished days only
      if(to <= from) continue;                           // the 1st of the month: nothing finished yet
      string file = sym + "_" + IntegerToString(yy) + "." + Two(mm) + ".csv";
      if(k >= 2 && FileIsExist(Folder + "\\" + sym + "\\" + file)) continue;
      if(!WriteRange(sym, from, to, file) && k <= 1) ok = false;
   }
   return ok;
}

void ExportAll()
{
   datetime today = Today();
   bool ok = true;
   for(int i = 0; i < ArraySize(syms); i++)
      if(!ExportSymbol(syms[i], today)) ok = false;
   // when MT4 was still downloading history, try again at the next check
   if(ok) exportedDay = today;

   // Status: lets FX Practice check the server time zone (offset = server - GMT, in seconds)
   datetime now = TimeCurrent();
   int f = FileOpen(Folder + "\\_status.tmp", FILE_WRITE | FILE_TXT | FILE_ANSI);
   if(f == INVALID_HANDLE) return;
   FileWriteString(f, "server,gmt,offset_sec,company,server_name,exported_until\r\n");
   FileWriteString(f, TimeToString(now, TIME_DATE | TIME_SECONDS) + "," +
                      TimeToString(TimeGMT(), TIME_DATE | TIME_SECONDS) + "," +
                      IntegerToString((int)(now - TimeGMT())) + "," +
                      AccountCompany() + "," + AccountServer() + "," +
                      TimeToString(today, TIME_DATE) + "\r\n");
   FileClose(f);
   FileMove(Folder + "\\_status.tmp", 0, Folder + "\\_status.csv", FILE_REWRITE);
}
