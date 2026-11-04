param([Parameter(Mandatory=$true)][string]$Executable,[Parameter(Mandatory=$true)][string]$Icon)
$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @'
using System; using System.IO; using System.Collections.Generic; using System.Runtime.InteropServices;
public static class NekofansIcon {
 delegate bool NameCallback(IntPtr module,IntPtr type,IntPtr name,IntPtr param);
 delegate bool LangCallback(IntPtr module,IntPtr type,IntPtr name,ushort lang,IntPtr param);
 [DllImport("kernel32",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr LoadLibraryEx(string path,IntPtr file,uint flags);
 [DllImport("kernel32")] static extern bool FreeLibrary(IntPtr module);
 [DllImport("kernel32",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool EnumResourceNames(IntPtr module,IntPtr type,NameCallback callback,IntPtr param);
 [DllImport("kernel32",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool EnumResourceLanguages(IntPtr module,IntPtr type,IntPtr name,LangCallback callback,IntPtr param);
 [DllImport("kernel32",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr BeginUpdateResource(string path,bool delete);
 [DllImport("kernel32",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool UpdateResource(IntPtr update,IntPtr type,IntPtr name,ushort lang,byte[] data,uint size);
 [DllImport("kernel32",SetLastError=true)] static extern bool EndUpdateResource(IntPtr update,bool discard);
 static void Check(bool success){if(!success)throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());}
 public static void Set(string executable,string icon){
  byte[] ico=File.ReadAllBytes(icon); if(ico.Length<22||BitConverter.ToUInt16(ico,0)!=0||BitConverter.ToUInt16(ico,2)!=1)throw new Exception("Invalid ICO");
  int count=BitConverter.ToUInt16(ico,4);if(count<1||count>32||ico.Length<6+16*count)throw new Exception("Invalid ICO directory");
  var groups=new List<Tuple<int,ushort>>();IntPtr module=LoadLibraryEx(executable,IntPtr.Zero,0x22);Check(module!=IntPtr.Zero);
  try{ NameCallback names=(m,t,n,p)=>{long id=n.ToInt64();if(id<1||id>65535)throw new Exception("Named icon groups unsupported");LangCallback langs=(lm,lt,ln,l,lp)=>{groups.Add(Tuple.Create((int)id,l));return true;};Check(EnumResourceLanguages(m,t,n,langs,IntPtr.Zero));return true;};EnumResourceNames(module,(IntPtr)14,names,IntPtr.Zero); }finally{FreeLibrary(module);}
  if(groups.Count==0)groups.Add(Tuple.Create(1,(ushort)0));
  byte[] group=new byte[6+14*count];Array.Copy(ico,group,6);
  IntPtr handle=BeginUpdateResource(executable,false);Check(handle!=IntPtr.Zero);bool finished=false;
  try{
   for(int i=0;i<count;i++){int src=6+16*i,dst=6+14*i;uint size=BitConverter.ToUInt32(ico,src+8),offset=BitConverter.ToUInt32(ico,src+12);if(size==0||(long)offset+size>ico.Length)throw new Exception("Invalid ICO image bounds");Array.Copy(ico,src,group,dst,12);Array.Copy(BitConverter.GetBytes((ushort)(i+1)),0,group,dst+12,2);byte[] data=new byte[size];Array.Copy(ico,offset,data,0,size);foreach(var lang in new HashSet<ushort>(groups.ConvertAll(g=>g.Item2)))Check(UpdateResource(handle,(IntPtr)3,(IntPtr)(i+1),lang,data,size));}
   foreach(var g in groups)Check(UpdateResource(handle,(IntPtr)14,(IntPtr)g.Item1,g.Item2,group,(uint)group.Length));
   Check(EndUpdateResource(handle,false));finished=true;
  }finally{if(!finished)EndUpdateResource(handle,true);}
 }
}
'@
[NekofansIcon]::Set((Resolve-Path -LiteralPath $Executable).Path,(Resolve-Path -LiteralPath $Icon).Path)
