using System;
using System.IO;
using System.IO.Compression;
using System.Diagnostics;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Windows.Forms;
using System.Reflection;
[assembly: AssemblyTitle("Nekofans")]
[assembly: AssemblyProduct("Nekofans Workbench")]
[assembly: AssemblyDescription("Nekofans Windows portable launcher")]
[assembly: AssemblyVersion("0.28.37.0")]

// The payload is a bounded ZIP stream followed by NEKOSFX1, its length and SHA256.
// Application data is never stored in the extracted version directory.
sealed class PayloadStream : Stream {
    readonly Stream inner; readonly long start, length;
    public PayloadStream(Stream inner,long start,long length){this.inner=inner;this.start=start;this.length=length;inner.Position=start;}
    public override bool CanRead{get{return true;}} public override bool CanSeek{get{return true;}} public override bool CanWrite{get{return false;}}
    public override long Length{get{return length;}} public override long Position{get{return inner.Position-start;}set{Seek(value,SeekOrigin.Begin);}}
    public override int Read(byte[] b,int o,int c){return inner.Read(b,o,(int)Math.Min(c,Math.Max(0,length-Position)));}
    public override long Seek(long o,SeekOrigin w){long p=w==SeekOrigin.Begin?o:w==SeekOrigin.Current?Position+o:length+o;if(p<0||p>length)throw new IOException("Invalid payload position");inner.Position=start+p;return p;}
    public override void Flush(){} public override void SetLength(long n){throw new NotSupportedException();} public override void Write(byte[] b,int o,int c){throw new NotSupportedException();}
}
static class Program {
    static string Hex(byte[] bytes){return BitConverter.ToString(bytes).Replace("-","").ToLowerInvariant();}
    static string NativePath(string value){
        if(value.StartsWith(@"\\?\"))return value;
        var full=Path.GetFullPath(value);
        if(Environment.OSVersion.Platform!=PlatformID.Win32NT)return full;
        return full.StartsWith(@"\\")?@"\\?\UNC\"+full.Substring(2):@"\\?\"+full;
    }
    static Form Progress(){var f=new Form{Text="Nekofans",Width=370,Height=125,StartPosition=FormStartPosition.CenterScreen,FormBorderStyle=FormBorderStyle.FixedDialog,MaximizeBox=false,MinimizeBox=false,ControlBox=false};f.Controls.Add(new Label{Text="首次启动，正在准备工作台…",Left=22,Top=20,AutoSize=true});f.Controls.Add(new ProgressBar{Left=22,Top=48,Width=310,Height=12,Style=ProgressBarStyle.Marquee});f.Show();Application.DoEvents();return f;}
    [STAThread] static int Main(string[] args){
        AppContext.SetSwitch("Switch.System.IO.UseLegacyPathHandling",false);
        AppContext.SetSwitch("Switch.System.IO.BlockLongPaths",false);
        bool extract=args.Length==2&&args[0]=="--extract-only";
        Form progress=null;string staging=null;
        try{
            string self=Assembly.GetExecutingAssembly().Location;
            using(var input=File.OpenRead(self)){
                if(input.Length<48)throw new IOException("Incomplete Nekofans package");
                input.Position=input.Length-48;byte[] footer=new byte[48];int read=input.Read(footer,0,footer.Length);
                if(read!=48||Encoding.ASCII.GetString(footer,0,8)!="NEKOSFX1")throw new IOException("Invalid Nekofans package");
                long size=BitConverter.ToInt64(footer,8);if(size<=0||size>input.Length-48)throw new IOException("Invalid payload length");
                byte[] expected=new byte[32];Array.Copy(footer,16,expected,0,32);string digest=Hex(expected);
                string destination=extract?Path.GetFullPath(args[1]):Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"NEKOfuns","portable",digest.Substring(0,20));
                using(var mutex=new Mutex(false,"Local\\NEKOfunsPortable_"+digest.Substring(0,20))){
                    try{mutex.WaitOne();}catch(AbandonedMutexException){}
                    try{
                        string marker=Path.Combine(destination,".neko-package-sha256");
                        bool ready=!extract&&File.Exists(NativePath(marker))&&File.ReadAllText(NativePath(marker)).Trim()==digest&&File.Exists(NativePath(Path.Combine(destination,"NEKOfuns.exe")));
                        if(!ready){
                            if(Directory.Exists(NativePath(destination))||File.Exists(NativePath(destination)))throw new IOException("目标目录已存在，未覆盖："+destination);
                            if(!extract)progress=Progress();
                            using(var payload=new PayloadStream(input,input.Length-48-size,size)){
                                using(var hash=SHA256.Create())if(Hex(hash.ComputeHash(payload))!=digest)throw new IOException("程序包校验失败，请重新获取文件。");
                                payload.Position=0;
                                string parent=Path.GetDirectoryName(destination);Directory.CreateDirectory(NativePath(parent));
                                staging=Path.Combine(parent,".preparing-"+Guid.NewGuid().ToString("N"));Directory.CreateDirectory(NativePath(staging));
                                string prefix=Path.GetFullPath(staging)+Path.DirectorySeparatorChar;
                                using(var zip=new ZipArchive(payload,ZipArchiveMode.Read,true))foreach(var entry in zip.Entries){
                                    if(entry.FullName.IndexOf(':')>=0||entry.FullName.IndexOf('\0')>=0)throw new IOException("Invalid archive path");
                                    string target=Path.GetFullPath(Path.Combine(staging,entry.FullName.Replace('/',Path.DirectorySeparatorChar)));
                                    if(!target.StartsWith(prefix,StringComparison.OrdinalIgnoreCase))throw new IOException("Archive path outside package");
                                    if(entry.FullName.EndsWith("/")||entry.FullName.EndsWith("\\")){Directory.CreateDirectory(NativePath(target));continue;}
                                    Directory.CreateDirectory(NativePath(Path.GetDirectoryName(target)));
                                    using(var source=entry.Open())using(var output=new FileStream(NativePath(target),FileMode.CreateNew,FileAccess.Write,FileShare.None))source.CopyTo(output);
                                    if(progress!=null)Application.DoEvents();
                                }
                            }
                            if(!File.Exists(NativePath(Path.Combine(staging,"NEKOfuns.exe"))))throw new IOException("Application executable missing");
                            File.WriteAllText(NativePath(Path.Combine(staging,".neko-package-sha256")),digest);
                            Directory.Move(NativePath(staging),NativePath(destination));staging=null;
                        }
                    }finally{mutex.ReleaseMutex();}
                }
                if(progress!=null){progress.Close();progress=null;}
                if(!extract){var start=new ProcessStartInfo(Path.Combine(destination,"NEKOfuns.exe")){WorkingDirectory=destination,UseShellExecute=false};start.EnvironmentVariables.Remove("ELECTRON_RUN_AS_NODE");Process.Start(start);}
            }
            return 0;
        }catch(Exception e){if(progress!=null)progress.Close();if(extract)Console.Error.WriteLine(e.ToString());else MessageBox.Show(e.Message,"Nekofans 启动失败",MessageBoxButtons.OK,MessageBoxIcon.Error);return 1;}
        // Failed preparations are left in their unique staging directory; no
        // existing application, user profile or workspace is ever removed.
    }
}
