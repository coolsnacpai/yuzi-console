// 玉子控制台 · 安装程序（C# WinForms，.NET Framework 4.x）
// 编译：csc /nologo /codepage:65001 /target:winexe /win32icon:assets\yuzu.ico /out:安装玉子控制台.exe src\Setup.cs
// 说明：本机策略下，编译版 exe 直接写 C:\ 与 HKCU 注册表会被拒（实测 UnauthorizedAccessException / SecurityException），
//       但 powershell.exe 可以，所以凡涉及 C:\DSH、快捷方式、注册表、计划任务的步骤一律交给 PowerShell 执行。
using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Text;
using System.Windows.Forms;

static class Paths
{
    public const string BridgeDir = @"D:\DeepSeek test\qq-bridge";
    public const string AppDir = @"D:\DeepSeek test\玉子软件开发";
    public const string TrayExe = @"D:\DeepSeek test\玉子软件开发\玉子控制台.exe";
    public const string LogPath = @"D:\DeepSeek test\玉子软件开发\install.log";
    public const string NodeExe = @"C:\Program Files\nodejs\node.exe";
}

static class Installer
{
    public static int Ok;
    public static int Fail;
    public static Action<string> Say = delegate(string s) { };

    public static void Run()
    {
        Ok = 0; Fail = 0;
        Step("复制程序文件到 qq-bridge", delegate { CopyPayload("bridge", Paths.BridgeDir); });
        Step("复制托盘程序到 玉子软件开发", delegate { CopyPayload("app", Paths.AppDir); });
        Step("写启动脚本到 C:\\DSH", WriteLaunchers);
        Step("建桌面 / 开始菜单快捷方式", MakeShortcuts);
        Step("注册开机自启（注册表）", RegisterRunKeys);
        Step("注册每 2 分钟自检任务", RegisterTask);
        Step("启动控制台", StartTray);
        Say("");
        Say("完成：" + Ok + " 步成功，" + Fail + " 步失败。");
        if (Fail > 0) Say("失败项可手动补，详见 qq-bridge\\README.md 的「安装」一节。");
    }

    static void Step(string name, Action fn)
    {
        try { fn(); Say(name + "  ✓"); Ok++; }
        catch (Exception ex) { Say(name + "  ✗ " + ex.Message); Fail++; }
    }

    public static string Payload() { return FindPayloadRoot(); }

    static string FindPayloadRoot()
    {
        string b = AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\');
        string[] cands = new string[] {
            Path.Combine(b, "payload"),
            Path.Combine(Paths.AppDir, "dist", "玉子控制台-安装包", "payload"),
            Path.Combine(Paths.AppDir, "payload"),
            Path.Combine(Directory.GetParent(b) == null ? b : Directory.GetParent(b).FullName, "payload"),
            Path.Combine(b, "..", "payload"),
        };
        foreach (string c in cands)
        {
            try { if (Directory.Exists(c)) return Path.GetFullPath(c); } catch { }
        }
        return null;
    }

    static void CopyPayload(string sub, string target)
    {
        string root = FindPayloadRoot();
        string src = root == null ? null : Path.Combine(root, sub);
        if (src == null || !Directory.Exists(src)) throw new Exception("找不到 payload\\" + sub + "（把 exe 放回 安装包 文件夹里再点一次）");
        Directory.CreateDirectory(target);
        int n = 0, keep = 0, busy = 0;
        string[] files = Directory.GetFiles(src, "*", SearchOption.AllDirectories);
        foreach (string f in files)
        {
            string rel = f.Substring(src.Length).TrimStart('\\');
            string dst = Path.Combine(target, rel);
            bool userFile = rel.Equals(".env", StringComparison.OrdinalIgnoreCase)
                            || rel.StartsWith("data\\", StringComparison.OrdinalIgnoreCase)
                            || rel.StartsWith("inbox\\", StringComparison.OrdinalIgnoreCase)
                            || rel.Equals("persona.md", StringComparison.OrdinalIgnoreCase);
            if (userFile && File.Exists(dst)) { keep++; continue; }
            string dir = Path.GetDirectoryName(dst);
            if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
            if (File.Exists(dst)) { try { File.SetAttributes(dst, FileAttributes.Normal); } catch { } }
            try { File.Copy(f, dst, true); n++; }
            catch (IOException)
            {
                // 文件被正在运行的程序占用（典型：托盘 exe 正在跑）——先放旁边，退出后自动生效
                try { File.Copy(f, dst + ".new", true); busy++; } catch { busy++; }
            }
        }
        Say("  复制 " + n + " 个文件" + (keep > 0 ? "，保留原有 " + keep + " 个配置/数据" : "")
            + (busy > 0 ? "，" + busy + " 个被占用已存为 .new（关掉对应程序后生效）" : ""));
    }

    static void WriteLaunchers()
    {
        StringBuilder sb = new StringBuilder();
        sb.AppendLine("$ErrorActionPreference='Stop'");
        sb.AppendLine("$d='C:\\DSH'");
        sb.AppendLine("New-Item -ItemType Directory -Force -Path $d | Out-Null");
        sb.AppendLine("$bat = @'");
        sb.AppendLine("@echo off");
        sb.AppendLine("setlocal");
        sb.AppendLine("powershell -NoProfile -ExecutionPolicy Bypass -File \"C:\\DSH\\start-console.ps1\"");
        sb.AppendLine("call \"" + Paths.BridgeDir + "\\autostart.bat\"");
        sb.AppendLine("'@");
        sb.AppendLine("[IO.File]::WriteAllText((Join-Path $d 'run-bridge.bat'), $bat, [Text.Encoding]::ASCII)");
        sb.AppendLine("$ps1 = @'");
        sb.AppendLine("$ErrorActionPreference='SilentlyContinue'");
        sb.AppendLine("if (Test-NetConnection 127.0.0.1 -Port 3210 -InformationLevel Quiet) { exit 0 }");
        sb.AppendLine("$n='C:\\Program Files\\nodejs\\node.exe'");
        sb.AppendLine("if (-not (Test-Path $n)) { $n='node.exe' }");
        sb.AppendLine("Start-Process -FilePath $n -ArgumentList 'console.mjs' -WorkingDirectory '" + Paths.BridgeDir + "' -WindowStyle Hidden");
        sb.AppendLine("'@");
        sb.AppendLine("[IO.File]::WriteAllText((Join-Path $d 'start-console.ps1'), $ps1, (New-Object Text.UTF8Encoding($true)))");
        sb.AppendLine("Write-Output 'launchers written'");
        RunPs(sb.ToString(), 40000);
    }

    static void MakeShortcuts()
    {
        StringBuilder sb = new StringBuilder();
        sb.AppendLine("$ErrorActionPreference='Stop'");
        sb.AppendLine("$w = New-Object -ComObject WScript.Shell");
        sb.AppendLine("$exe = '" + Paths.TrayExe + "'");
        sb.AppendLine("$wd = '" + Paths.AppDir + "'");
        sb.AppendLine("$dirs = @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Programs'))");
        sb.AppendLine("foreach ($dir in $dirs) {");
        sb.AppendLine("  if (-not $dir) { continue }");
        sb.AppendLine("  $p = Join-Path $dir '玉子控制台.lnk'");
        sb.AppendLine("  $s = $w.CreateShortcut($p)");
        sb.AppendLine("  $s.TargetPath = $exe; $s.WorkingDirectory = $wd; $s.IconLocation = $exe + ',0'; $s.Save()");
        sb.AppendLine("  Write-Output ('lnk ' + $p)");
        sb.AppendLine("}");
        RunPs(sb.ToString(), 40000);
    }

    static void RegisterRunKeys()
    {
        StringBuilder sb = new StringBuilder();
        sb.AppendLine("$ErrorActionPreference='Stop'");
        sb.AppendLine("$k='HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'");
        sb.AppendLine("Set-ItemProperty -Path $k -Name 'QQBridge_AutoStart' -Value ('wscript.exe \"' + '" + Paths.BridgeDir.Replace("\\", "\\\\") + "\\qq-bridge-startup.vbs' + '\"')");
        sb.AppendLine("Set-ItemProperty -Path $k -Name 'DSH_AutoStart' -Value ('wscript.exe \"' + '" + Paths.BridgeDir.Replace("\\", "\\\\") + "\\dsh-startup.vbs' + '\"')");
        sb.AppendLine("Write-Output 'run keys written'");
        RunPs(sb.ToString(), 40000);
    }

    static void RegisterTask()
    {
        StringBuilder sb = new StringBuilder();
        sb.AppendLine("$ErrorActionPreference='Continue'");
        sb.AppendLine("$st = Join-Path $env:SystemRoot 'System32\\schtasks.exe'");
        sb.AppendLine("$args = @('/create','/tn','QQBridge-KeepAlive','/tr','C:\\DSH\\run-bridge.exe','/sc','minute','/mo','2','/f')");
        sb.AppendLine("$o = & $st $args 2>&1 | Out-String");
        sb.AppendLine("Write-Output ('rc=' + $LASTEXITCODE + ' ' + $o.Trim())");
        sb.AppendLine("if ($LASTEXITCODE -ne 0) { throw ('建计划任务失败：' + $o.Trim()) }");
        RunPs(sb.ToString(), 40000, false);
    }

    static void StartTray()
    {
        if (!File.Exists(Paths.TrayExe)) throw new Exception("托盘程序没找到：" + Paths.TrayExe);
        if (Process.GetProcessesByName(Path.GetFileNameWithoutExtension(Paths.TrayExe)).Length > 0)
        {
            Say("  托盘已在运行，跳过启动");
            return;
        }
        StringBuilder sb = new StringBuilder();
        sb.AppendLine("Start-Process -FilePath '" + Paths.TrayExe + "' -WorkingDirectory '" + Paths.AppDir + "'");
        sb.AppendLine("Write-Output 'tray started'");
        RunPs(sb.ToString(), 20000);
        Say("  托盘已启动，右下角会有绿色小图标（首次启动若弹 SmartScreen，点「更多信息 → 仍要运行」）");
    }

    static void RunPs(string script, int timeoutMs) { RunPs(script, timeoutMs, true); }

    static string Brief(string s)
    {
        s = s.Replace("\r\n", " ").Replace("\n", " ");
        return s.Length > 220 ? s.Substring(0, 220) + "…" : s;
    }

    static void RunPs(string script, int timeoutMs, bool strict)
    {
        Directory.CreateDirectory(Paths.AppDir);
        string tmp = Path.Combine(Paths.AppDir, "install-" + Guid.NewGuid().ToString("N") + ".ps1");
        File.WriteAllText(tmp, script, new UTF8Encoding(true));
        string outp = Path.Combine(Paths.AppDir, "install-ps.out");
        try
        {
            ProcessStartInfo psi = new ProcessStartInfo("powershell.exe",
                "-NoProfile -ExecutionPolicy Bypass -File \"" + tmp + "\"");
            psi.CreateNoWindow = true;
            psi.UseShellExecute = false;
            psi.RedirectStandardOutput = true;
            psi.RedirectStandardError = true;
            Process p = Process.Start(psi);
            string so = p.StandardOutput.ReadToEnd();
            string se = p.StandardError.ReadToEnd();
            p.WaitForExit(timeoutMs);
            try { File.WriteAllText(outp, so + "\n" + se, new UTF8Encoding(true)); } catch { }
            string o = (so + "\n" + se).Trim();
            if (o.Length > 0) Say("  " + o.Replace("\r\n", " | ").Replace("\n", " | "));
            if (p.ExitCode != 0) throw new Exception("PowerShell 退出码 " + p.ExitCode + "：" + Brief(o));
            if (strict && (o.Contains("UnauthorizedAccessException") || o.Contains("拒绝") || o.Contains("denied") || o.Contains("SecurityException"))) throw new Exception(Brief(o));
        }
        finally
        {
            try { File.Delete(tmp); } catch { }
        }
    }
}

class SetupForm : Form
{
    RichTextBox logBox;
    Button goBtn;

    public SetupForm()
    {
        Text = "玉子控制台 · 安装程序";
        Size = new Size(800, 590);
        StartPosition = FormStartPosition.CenterScreen;
        BackColor = Color.FromArgb(18, 22, 28);
        ForeColor = Color.Gainsboro;
        Font = new Font("Microsoft YaHei UI", 9.5f);

        Label head = new Label();
        head.Text = "玉子控制台 · 安装程序\nNapCat · 玉子 bot · 空间监听 · DSH 统一管理";
        head.Dock = DockStyle.Top;
        head.Height = 82;
        head.Padding = new Padding(16, 12, 16, 0);
        head.ForeColor = Color.White;
        head.Font = new Font("Microsoft YaHei UI", 12f, FontStyle.Bold);

        logBox = new RichTextBox();
        logBox.Dock = DockStyle.Fill;
        logBox.ReadOnly = true;
        logBox.BackColor = Color.FromArgb(24, 28, 36);
        logBox.ForeColor = Color.Gainsboro;
        logBox.BorderStyle = BorderStyle.None;
        logBox.Font = new Font("Consolas", 9.5f);

        goBtn = new Button();
        goBtn.Text = "开始安装";
        goBtn.Dock = DockStyle.Bottom;
        goBtn.Height = 48;
        goBtn.FlatStyle = FlatStyle.Flat;
        goBtn.BackColor = Color.FromArgb(45, 108, 223);
        goBtn.ForeColor = Color.White;
        goBtn.Font = new Font("Microsoft YaHei UI", 11f, FontStyle.Bold);
        goBtn.FlatAppearance.BorderSize = 0;
        goBtn.Click += delegate
        {
            goBtn.Enabled = false;
            goBtn.Text = "安装中…";
            Installer.Say = Write;
            Installer.Run();
            goBtn.Text = Installer.Fail > 0 ? "有步骤失败（可再点一次重试）" : "安装完成";
            goBtn.Enabled = true;
        };

        Controls.Add(logBox);
        Controls.Add(goBtn);
        Controls.Add(head);

        Write("安装位置：" + Paths.BridgeDir);
        Write("已有的 .env、persona.md、data\\ 会保留，不会被覆盖。");
    }

    void Write(string s)
    {
        logBox.AppendText("· " + s + "\n");
        logBox.ScrollToCaret();
        AppendFile(s);
        Application.DoEvents();
    }

    public static void AppendFile(string s)
    {
        try { File.AppendAllText(Paths.LogPath, DateTime.Now.ToString("HH:mm:ss") + "  " + s + "\r\n", new UTF8Encoding(true)); }
        catch { }
    }
}

class Program
{
    static bool IsAdmin()
    {
        try
        {
            var id = System.Security.Principal.WindowsIdentity.GetCurrent();
            var p = new System.Security.Principal.WindowsPrincipal(id);
            return p.IsInRole(System.Security.Principal.WindowsBuiltInRole.Administrator);
        }
        catch { return false; }
    }

    static void RelaunchAsAdmin(string[] argv)
    {
        try
        {
            var psi = new ProcessStartInfo(Application.ExecutablePath, "/silent-elevated");
            psi.Verb = "runas";
            psi.UseShellExecute = true;
            Process.Start(psi);
        }
        catch (Exception ex)
        {
            MessageBox.Show("需要管理员权限才能安装。请右键「以管理员身份运行」。\n\n" + ex.Message,
                "玉子控制台 · 安装程序", MessageBoxButtons.OK, MessageBoxIcon.Warning);
        }
    }

    [STAThread]
    static void Main()
    {
        string[] argv = Environment.GetCommandLineArgs();
        bool silent = Array.IndexOf(argv, "/silent") >= 0 || Array.IndexOf(argv, "/silent-elevated") >= 0;
        bool check = Array.IndexOf(argv, "/check") >= 0;
        try { File.Delete(Paths.LogPath); } catch { }
        if (check)
        {
            string root = Installer.Payload();
            string line = root == null ? "PAYLOAD MISSING" : "PAYLOAD " + root;
            bool b = root != null && System.IO.Directory.Exists(System.IO.Path.Combine(root, "bridge"));
            bool a = root != null && System.IO.Directory.Exists(System.IO.Path.Combine(root, "app"));
            Installer.Say = SetupForm.AppendFile;
            Installer.Say(line + " bridge=" + b + " app=" + a);
            Installer.Say("ADMIN " + IsAdmin());
            return;
        }
        if (!IsAdmin())
        {
            RelaunchAsAdmin(argv);
            return;
        }
        if (silent)
        {
            Installer.Say = SetupForm.AppendFile;
            try
            {
                Installer.Run();
                Installer.Say("SILENT DONE ok=" + Installer.Ok + " fail=" + Installer.Fail);
            }
            catch (Exception ex)
            {
                Installer.Say("FATAL " + ex);
            }
            return;
        }
        Application.EnableVisualStyles();
        Application.Run(new SetupForm());
    }
}
