//+------------------------------------------------------------------+
//| R_ExportHistory.mq4                                               |
//| Writes account history (closed trades) and open positions to CSV |
//| for FX Practice ("MT4 history" import).                          |
//|                                                                    |
//| Kept as UTF-8 in git; npm run deploy-mt4 copies it to the MT4     |
//| data folder as UTF-16 (MetaEditor reads Japanese correctly then). |
//| Japanese instructions: see CLAUDE.md ("MT4 history").             |
//|                                                                    |
//| 1. Put this file in <data folder>\MQL4\Scripts and compile it.   |
//| 2. Account History tab -> right click -> "All History"            |
//|    (only the period shown there can be exported).                 |
//| 3. Drop the script on any chart.                                   |
//| 4. Output: <data folder>\MQL4\Files\fx_practice_history.csv       |
//| Times are written in MT4 server time.                             |
//+------------------------------------------------------------------+
#property strict
#property script_show_inputs
#property version     "1.01"
#property copyright   "R（FX Practice 用の自作ツール）"
#property description "FX Practice の「MT4 履歴」タブ用に、取引履歴を書き出すスクリプトです。注文は出しません。"
#property description "決済した取引と保有中のポジションを MQL4\\Files\\fx_practice_history.csv に書きます（時刻はサーバー時刻）。"
#property description "先に「口座履歴」タブで右クリック →「全履歴」を選んでください（表示中の期間だけが書き出されるため）。"
#property description "チャートにドラッグするたびに 1 回だけ書き出します。"

input string FileName = "fx_practice_history.csv"; // Output file (in MQL4\Files)

string Price(string symbol, double p)
{
   if(p <= 0) return "0";
   int digits = (int)MarketInfo(symbol, MODE_DIGITS);
   if(digits <= 0) digits = 5;
   return DoubleToString(p, digits);
}

string Time(datetime t)
{
   if(t <= 0) return "";
   return TimeToString(t, TIME_DATE | TIME_SECONDS);
}

string Clean(string s)
{
   StringReplace(s, ",", " ");
   StringReplace(s, "\n", " ");
   return s;
}

void WriteOrder(int f, bool closed)
{
   int type = OrderType();
   if(type != OP_BUY && type != OP_SELL) return;
   string symbol = OrderSymbol();
   string line = IntegerToString(OrderTicket()) + "," +
                 Time(OrderOpenTime()) + "," +
                 (type == OP_BUY ? "buy" : "sell") + "," +
                 DoubleToString(OrderLots(), 2) + "," +
                 symbol + "," +
                 Price(symbol, OrderOpenPrice()) + "," +
                 Price(symbol, OrderStopLoss()) + "," +
                 Price(symbol, OrderTakeProfit()) + "," +
                 (closed ? Time(OrderCloseTime()) : "") + "," +
                 (closed ? Price(symbol, OrderClosePrice()) : "") + "," +
                 DoubleToString(OrderCommission(), 2) + "," +
                 DoubleToString(OrderSwap(), 2) + "," +
                 DoubleToString(OrderProfit(), 2) + "," +
                 Clean(OrderComment());
   FileWriteString(f, line + "\r\n");
}

void OnStart()
{
   int f = FileOpen(FileName, FILE_WRITE | FILE_TXT | FILE_ANSI);
   if(f == INVALID_HANDLE)
   {
      Alert("Cannot create file: ", GetLastError());
      return;
   }
   FileWriteString(f, "ticket,open_time,type,lots,symbol,open_price,sl,tp,close_time,close_price,commission,swap,profit,comment\r\n");

   int history = 0;
   for(int i = 0; i < OrdersHistoryTotal(); i++)
   {
      if(!OrderSelect(i, SELECT_BY_POS, MODE_HISTORY)) continue;
      WriteOrder(f, true);
      history++;
   }
   int open = 0;
   for(int i = 0; i < OrdersTotal(); i++)
   {
      if(!OrderSelect(i, SELECT_BY_POS, MODE_TRADES)) continue;
      WriteOrder(f, false);
      open++;
   }
   FileClose(f);
   Alert("Exported: history ", history, " / open ", open, " -> MQL4\\Files\\", FileName);
}
