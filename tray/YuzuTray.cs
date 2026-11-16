// 玉子控制台 · 托盘宿主（C# / .NET Framework 4.x WinForms，ApplicationContext 版）
// 编译：csc /target:winexe /win32icon:assets\yuzu.ico /out:玉子控制台.exe src\YuzuTray.cs
using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Net.WebSockets;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;

class YuzuApp : ApplicationContext
{
    const string BridgeDir = @"D:\DeepSeek test\qq-bridge";
    const string EdgeExe = @"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe";
    const string BaseUrl = "http://127.0.0.1:3210";
    const string NodeExe = @"C:\Program Files\nodejs\node.exe";
    static string LogPath = Path.Combine(BridgeDir, "data", "tray.log");
    static string ShowFlag = Path.Combine(BridgeDir, "data", "open.request");

    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);

    NotifyIcon ni;
    System.Windows.Forms.Timer watcher;
    System.Windows.Forms.Timer focusTimer;
    System.Windows.Forms.Timer qrTimer;
    long lastQrAt;
    int focusTries;
    Icon trayIcon;

    [STAThread]
    static void Main()
    {
        Log("MAIN enter");
        AppDomain.CurrentDomain.UnhandledException += (s, e) => Log("FATAL " + e.ExceptionObject);
        bool first;
        using (var m = new Mutex(true, "YuzuConsoleTray_SingleInstance", out first))
        {
            if (!first)
            {
                // 已经有一个在跑：不退出，改成请求它把窗口叫到前面来
                try
                {
                    Directory.CreateDirectory(Path.GetDirectoryName(ShowFlag));
                    File.WriteAllText(ShowFlag, DateTime.Now.ToString("o"));
                    Log("已有实例，已写出唤起请求");
                }
                catch (Exception ex) { Log("写唤起请求失败 " + ex.Message); }
                return;
            }
            try
            {
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                Application.Run(new YuzuApp());
            }
            catch (Exception ex) { Log("RUN ERR " + ex); }
        }
    }

    static void Log(string msg)
    {
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(LogPath));
            File.AppendAllText(LogPath, "[" + DateTime.Now.ToString("MM-dd HH:mm:ss") + "] " + msg + "\r\n");
        }
        catch { }
    }

    public YuzuApp()
    {
        Log("启动，exe=" + Application.ExecutablePath);
        var menu = new ContextMenuStrip();
        var miConsole = new ToolStripMenuItem("打开控制台", null, (s, e) => OpenConsole()) { Font = new Font("Microsoft YaHei UI", 9F, FontStyle.Bold) };
        var miRestart = new ToolStripMenuItem("全部重启", null, (s, e) => RestartAll());
        var miStop = new ToolStripMenuItem("全部停止", null, (s, e) => StopAll());
        var miData = new ToolStripMenuItem("打开数据目录", null, (s, e) => OpenDir(Path.Combine(BridgeDir, "data")));
        var miDriver = new ToolStripMenuItem("打开 NapCat 目录", null, (s, e) => OpenDir(@"D:\NapCat\NapCat.52230.Shell"));
        var miExit = new ToolStripMenuItem("退出托盘", null, (s, e) => Quit());
        menu.Items.Add(miConsole);
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add(miRestart);
        menu.Items.Add(miStop);
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add(miData);
        menu.Items.Add(miDriver);
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add(miExit);

        trayIcon = LoadIcon();
        ni = new NotifyIcon();
        ni.Icon = trayIcon;
        ni.Text = "玉子控制台";
        ni.Visible = true;
        ni.ContextMenuStrip = menu;
        ni.DoubleClick += (s, e) => OpenConsole();
        ni.ShowBalloonTip(1500, "玉子控制台", "双击图标打开控制台", ToolTipIcon.Info);

        var th = new Thread(() =>
        {
            Thread.Sleep(200);
            EnsureConsole();
            OpenConsole();
        });
        th.IsBackground = true;
        th.Start();

        // 监听“唤起请求”：再加一次启动、或者点了托盘图标以外的入口时，把窗口顶到最前
        watcher = new System.Windows.Forms.Timer { Interval = 700 };
        watcher.Tick += (s, e) =>
        {
            try
            {
                if (!HandleSaveRequest()) { }
                if (!File.Exists(ShowFlag)) return;
                File.Delete(ShowFlag);
                Log("收到唤起请求");
                OpenConsole();
            }
            catch { }
        };
        watcher.Start();

        focusTimer = new System.Windows.Forms.Timer { Interval = 400 };
        focusTimer.Tick += (s, e) =>
        {
            focusTries++;
            if (FocusConsole()) { focusTimer.Stop(); Log("窗口已置前"); return; }
            if (focusTries == 6) { try { LaunchEdge(); Log("再拉一次 Edge"); } catch { } }
            if (focusTries >= 15) { focusTimer.Stop(); Log("没找到控制台窗口句柄"); }
        };

        // 掉登录时 NapCat 只会静静躺在那儿等扫码，QQ 那头完全没反应。托盘每 30 秒看一眼，
        // 一旦发现「后端在跑但 3001 没开」，就弹气泡提醒主人扫码，别等半天才发现没人回消息。
        qrTimer = new System.Windows.Forms.Timer { Interval = 30000 };
        qrTimer.Tick += (s, e) => CheckQrNeed();
        qrTimer.Start();
    }

    // 控制台要「自由选目录保存」时，把字节丢到这里，由托盘弹 Windows 原生另存为。
    // 原因：控制台窗口是 Edge --app，下载/文件选择器在这套环境里被沙箱挡住，写不出文件。
    bool savingNow;
    bool HandleSaveRequest()
    {
        if (savingNow) return false;
        string dir = Path.Combine(BridgeDir, "data", "save");
        if (!Directory.Exists(dir)) return false;
        string[] reqs;
        try { reqs = Directory.GetFiles(dir, "*.req"); } catch { return false; }
        if (reqs.Length == 0) return false;
        string reqFile = reqs[0];
        string id = Path.GetFileNameWithoutExtension(reqFile);
        string binFile = Path.Combine(dir, id + ".bin");
        string resFile = Path.Combine(dir, id + ".res");
        string name = "export.bin";
        try
        {
            string json = File.ReadAllText(reqFile);
            var m = System.Text.RegularExpressions.Regex.Match(json, "\"name\"\\s*:\\s*\"([^\"]*)\"");
            if (m.Success) name = m.Groups[1].Value;
            byte[] buf = File.ReadAllBytes(binFile);
            string ext = Path.GetExtension(name).ToLowerInvariant();
            string filter = "所有文件 (*.*)|*.*";
            if (ext == ".yzm") filter = "玉子记忆包 (*.yzm)|*.yzm|所有文件 (*.*)|*.*";
            else if (ext == ".yzp") filter = "玉子性格包 (*.yzp)|*.yzp|所有文件 (*.*)|*.*";
            else if (ext == ".docx") filter = "Word 文档 (*.docx)|*.docx|所有文件 (*.*)|*.*";
            else if (ext == ".doc") filter = "Word 文档 (*.doc)|*.doc|所有文件 (*.*)|*.*";
            else if (ext == ".md") filter = "Markdown (*.md)|*.md|所有文件 (*.*)|*.*";

            savingNow = true;
            try { File.Delete(reqFile); } catch { }
            savingNow = true;
            try { File.Delete(reqFile); } catch { }
            Log("另存为请求：" + name + "（" + (buf.Length / 1024) + "KB）");
            using (var dlg = new SaveFileDialog())
            {
                dlg.Title = "玉子控制台 - 保存 " + name;
                dlg.FileName = name;
                dlg.Filter = filter;
                dlg.InitialDirectory = Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory);
                dlg.RestoreDirectory = true;
                dlg.OverwritePrompt = true;
                DialogResult r;
                using (var owner = new Form())
                {
                    owner.Text = "玉子保存";
                    owner.FormBorderStyle = FormBorderStyle.None;
                    owner.StartPosition = FormStartPosition.Manual;
                    owner.Location = new Point(Screen.PrimaryScreen.WorkingArea.Right - 1, Screen.PrimaryScreen.WorkingArea.Bottom - 1);
                    owner.Size = new Size(1, 1);
                    owner.ShowInTaskbar = false;
                    owner.TopMost = true;
                    owner.Show();
                    owner.Activate();
                    r = dlg.ShowDialog(owner);
                    owner.Hide();
                }
                if (r != DialogResult.OK)
                {
                    File.WriteAllText(resFile, "CANCEL", System.Text.Encoding.UTF8);
                    Log("用户取消保存");
                }
                else
                {
                    File.WriteAllBytes(dlg.FileName, buf);
                    File.WriteAllText(resFile, "OK|" + dlg.FileName, System.Text.Encoding.UTF8);
                    Log("已保存：" + dlg.FileName);
                }
            }
        }
        catch (Exception ex)
        {
            try { File.WriteAllText(resFile, "ERR|" + ex.Message, System.Text.Encoding.UTF8); } catch { }
            Log("save err " + ex.Message);
        }
        finally
        {
            savingNow = false;
            try { File.Delete(reqFile); } catch { }
            try { File.Delete(binFile); } catch { }
        }
        return true;
    }

    void CheckQrNeed()
    {
        try
        {
            string body = Get(BaseUrl + "/api/status", 2500);
            if (body == null) return;
            var m = System.Text.RegularExpressions.Regex.Match(body, "\"napcat\"\\s*:\\s*\\{[^}]*\\}");
            if (!m.Success) return;
            string nap = m.Value;
            bool up = System.Text.RegularExpressions.Regex.IsMatch(nap, "\"up\"\\s*:\\s*true");
            bool bootAlive = System.Text.RegularExpressions.Regex.IsMatch(nap, "\"bootAlive\"\\s*:\\s*[1-9]");
            var qa = System.Text.RegularExpressions.Regex.Match(nap, "\"qrAt\"\\s*:\\s*(\\d+)");
            long qrAt = qa.Success ? long.Parse(qa.Groups[1].Value) : 0;
            if (up) { lastQrAt = 0; return; }
            if (!bootAlive || qrAt == 0 || qrAt == lastQrAt) return;
            lastQrAt = qrAt;
            ni.ShowBalloonTip(8000, "玉子需要扫码登录", "NapCat 在等扫码，QQ 这会儿收不到消息。点托盘图标打开控制台扫码。", ToolTipIcon.Warning);
            Log("提示扫码 qrAt=" + qrAt);
        }
        catch (Exception ex) { Log("qr check err " + ex.Message); }
    }
    static string Get(string url, int timeoutMs)
    {
        try
        {
            var req = (HttpWebRequest)WebRequest.Create(url);
            req.Timeout = timeoutMs;
            req.ReadWriteTimeout = timeoutMs;
            using (var r = req.GetResponse())
            using (var sr = new StreamReader(r.GetResponseStream()))
                return sr.ReadToEnd();
        }
        catch { return null; }
    }

    Icon LoadIcon()
    {
        try
        {
            string p = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "assets", "yuzu.ico");
            if (File.Exists(p)) return new Icon(p, 32, 32);
        }
        catch (Exception ex) { Log("icon err " + ex.Message); }
        try
        {
            var ico = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
            if (ico != null) return ico;
        }
        catch { }
        return SystemIcons.Application;
    }

    static bool Probe(int port, int ms = 400)
    {
        try
        {
            using (var c = new TcpClient())
            {
                var ar = c.BeginConnect("127.0.0.1", port, null, null);
                if (!ar.AsyncWaitHandle.WaitOne(ms)) return false;
                c.EndConnect(ar);
                return true;
            }
        }
        catch { return false; }
    }

    void EnsureConsole()
    {
        if (Probe(3210)) return;
        Log("控制台未运行，拉起");
        try
        {
            var psi = new ProcessStartInfo(NodeExe, "console.mjs")
            {
                WorkingDirectory = BridgeDir,
                UseShellExecute = false,
                CreateNoWindow = true,
                WindowStyle = ProcessWindowStyle.Hidden
            };
            Process.Start(psi);
        }
        catch (Exception ex) { Log("拉起失败 " + ex.Message); }
        for (int i = 0; i < 24; i++)
        {
            if (Probe(3210)) { Log("控制台已就绪"); return; }
            Thread.Sleep(250);
        }
        Log("控制台 6 秒内没起来");
    }

    void OpenConsole()
    {
        EnsureConsole();
        try
        {
            // 旧窗口如果是在控制台没起来的时候开的，会永远停在空白页（页面没加载，JS 的自愈也跑不到），
            // 直接按窗口标题关掉再开，比猜它是不是白屏可靠。
            KillStaleWindow();
            LaunchEdge();
            Log("已打开控制台窗口");
            if (focusTimer != null) { focusTries = 0; focusTimer.Start(); }
        }
        catch (Exception ex)
        {
            Log("打开失败 " + ex.Message);
            MessageBox.Show("打不开控制台：" + ex.Message, "玉子控制台");
        }
    }

    void KillStaleWindow()
    {
        try
        {
            var psi = new ProcessStartInfo("cmd.exe", "/c taskkill /F /FI \"WINDOWTITLE eq 玉子控制台\" /IM msedge.exe")
            {
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true
            };
            var p = Process.Start(psi);
            p.WaitForExit(3000);
            if (p.ExitCode == 0) Log("关掉了旧的控制台窗口");
        }
        catch (Exception ex) { Log("关旧窗口失败 " + ex.Message); }
    }

    void LaunchEdge()
    {
        // 普通权限下 Edge 的渲染进程跑在 AppContainer 里，回环地址 127.0.0.1 被隔离，页面根本加载不出来，
        // 窗口标题只剩 "127.0.0.1_/" 的空白页。实测 --disable-features=RendererAppContainer 正好能修掉，
        // 而且比 --no-sandbox 温和得多（不会弹「不受支持的命令行标志」警告条，其余沙箱照旧）。
        string args = "--disable-features=RendererAppContainer --remote-debugging-port=9556 --app=" + BaseUrl + "/ --window-size=1200,880 --window-position=80,40 --user-data-dir=\""
            + Path.Combine(BridgeDir, "data", "edge-console") + "\"";
        var psi = new ProcessStartInfo(EdgeExe, args) { UseShellExecute = true };
        Process.Start(psi);
        Thread.Sleep(1400);
        if (!PageAlive())
        {
            Log("窗口疑似白屏，reload 一次");
            CdpEval("location.reload()", 3000);
            Thread.Sleep(2600);
        }
        if (!PageAlive() && !healing)
        {
            healing = true;
            Log("还是白屏，关掉重开一次");
            try { KillStaleWindow(); Thread.Sleep(600); LaunchEdge(); } catch (Exception ex) { Log("重开失败 " + ex.Message); }
            healing = false;
        }
    }

    bool healing = false;

    // 页面到底有没有渲染出来：读 body 文本长度（白屏时是 0）
    bool PageAlive()
    {
        string s = CdpEval("String(document.body ? document.body.innerText.length : 0)", 2500);
        int n;
        return int.TryParse(s, out n) && n > 200;
    }

    // 极简 CDP：连 /json/list 里第一个页面，Runtime.evaluate 一次，返回 value
    string CdpEval(string expr, int timeoutMs)
    {
        try
        {
            string list = Get("http://127.0.0.1:9556/json/list", timeoutMs);
            if (list == null) return null;
            var m = Regex.Match(list, "\"webSocketDebuggerUrl\"\\s*:\\s*\"([^\"]+)\"");
            if (!m.Success) return null;
            using (var ws = new ClientWebSocket())
            {
                var cts = new CancellationTokenSource(timeoutMs);
                ws.ConnectAsync(new Uri(m.Groups[1].Value), cts.Token).Wait(timeoutMs);
                string msg = "{\"id\":1,\"method\":\"Runtime.evaluate\",\"params\":{\"expression\":" + Quote(expr) + ",\"returnByValue\":true}}";
                var bytes = Encoding.UTF8.GetBytes(msg);
                ws.SendAsync(new ArraySegment<byte>(bytes), WebSocketMessageType.Text, true, cts.Token).Wait(timeoutMs);
                var buf = new byte[8192];
                var sb = new StringBuilder();
                while (true)
                {
                    var r = ws.ReceiveAsync(new ArraySegment<byte>(buf), cts.Token).Result;
                    sb.Append(Encoding.UTF8.GetString(buf, 0, r.Count));
                    if (r.EndOfMessage) break;
                }
                var vm = Regex.Match(sb.ToString(), "\"value\"\\s*:\\s*\"?([^,\"}]+)");
                return vm.Success ? Regex.Unescape(vm.Groups[1].Value) : null;
            }
        }
        catch { return null; }
    }

    static string Quote(string s)
    {
        return "\"" + s.Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\n", "\\n") + "\"";
    }

    // 找到控制台那个 Edge 窗口，还原并顶到最前
    bool FocusConsole()
    {
        foreach (var p in Process.GetProcessesByName("msedge"))
        {
            try
            {
                if (p.MainWindowHandle == IntPtr.Zero) continue;
                string t = p.MainWindowTitle ?? "";
                if (t.Contains("玉子控制台") || t.Contains("127.0.0.1:3210") || t.Contains("玉子"))
                {
                    ShowWindow(p.MainWindowHandle, 9);
                    return SetForegroundWindow(p.MainWindowHandle);
                }
            }
            catch { }
        }
        return false;
    }

    static void Post(string path)
    {
        try
        {
            var req = (HttpWebRequest)WebRequest.Create(BaseUrl + path);
            req.Method = "POST";
            req.Timeout = 6000;
            req.ContentLength = 0;
            using (var r = req.GetResponse()) { r.Close(); }
        }
        catch (Exception ex) { Log("POST " + path + " 失败 " + ex.Message); }
    }

    void RestartAll()
    {
        Post("/api/svc/watch/restart");
        Post("/api/svc/bot/restart");
        ni.ShowBalloonTip(1500, "玉子控制台", "已下发重启：玉子 + 空间监听", ToolTipIcon.Info);
    }

    void StopAll()
    {
        if (MessageBox.Show("将停止玉子 bot、空间监听、无头 Edge 以及 NapCat。\n日常用的 QQ 不受影响。\n\n确定吗？",
            "全部停止", MessageBoxButtons.OKCancel, MessageBoxIcon.Warning) != DialogResult.OK) return;
        Post("/api/svc/watch/stop");
        Post("/api/svc/bot/stop");
        Post("/api/svc/edge/stop");
        Post("/api/svc/napcat/stop");
        ni.ShowBalloonTip(1500, "玉子控制台", "已全部停止", ToolTipIcon.Warning);
    }

    void OpenDir(string p)
    {
        try { if (Directory.Exists(p)) Process.Start("explorer.exe", "\"" + p + "\""); else Log("目录不存在 " + p); }
        catch (Exception ex) { Log("打开目录失败 " + ex.Message); }
    }

    void Quit()
    {
        Log("退出托盘");
        ni.Visible = false;
        ni.Dispose();
        ExitThread();
    }
}
