; 网易云 163key 标签工具 —— Inno Setup 安装脚本
;
; 编译（由 Build-Release.ps1 自动调用）：
;   ISCC.exe /DMyAppVersion=0.3.0 installer\netease-163key-tagger.iss
;
; 产物：dist\netease-163key-tagger-setup-v<版本>.exe
;
; 风格对齐隔壁的 gacha-link-fetcher：
;   - 装到 Program Files（{autopf}），需要管理员
;   - lzma2/ultra64 压缩
;   - 简体中文向导，可选桌面快捷方式，装完可直接启动

#ifndef MyAppVersion
  #define MyAppVersion "0.3.0"
#endif

#define MyAppName "网易云 163key 标签工具"
#define MyAppExeName "netease-163key-tagger.exe"
#define MyAppPublisher "H0NG1Y"
#define MyAppUrl "https://github.com/H0NG1Y/netease-163key-tagger"

[Setup]
AppId={{12459E57-618E-4EBE-A128-5C308608F772}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppVerName={#MyAppName} v{#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL={#MyAppUrl}
AppSupportURL={#MyAppUrl}/issues
AppUpdatesURL={#MyAppUrl}/releases/latest
DefaultDirName={autopf}\netease-163key-tagger
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
OutputDir=..\dist
OutputBaseFilename=netease-163key-tagger-setup-v{#MyAppVersion}
UninstallDisplayIcon={app}\{#MyAppExeName}
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=admin
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
CloseApplications=yes
RestartApplications=yes
SetupLogging=yes
ChangesAssociations=no
; 改了环境变量就广播 WM_SETTINGCHANGE，让新开的程序能立刻认到
ChangesEnvironment=yes
DisableReadyPage=no
AllowNoIcons=yes

[Languages]
Name: "chinesesimp"; MessagesFile: "compiler:Languages\ChineseSimplified.isl"

[Tasks]
Name: "addtopath"; Description: "把安装目录加入系统 PATH（之后可在任意目录直接执行命令）"; GroupDescription: "命令行："
Name: "desktopicon"; Description: "创建桌面快捷方式"; GroupDescription: "附加快捷方式："; Flags: unchecked

[Files]
Source: "..\dist\netease-163key-tagger.exe"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{autoprograms}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon

; 只追加自己那一条，已经在 PATH 里就不重复加。
; preservestringtype 保住 REG_EXPAND_SZ，changesenvironment 让系统广播环境变量变化。
; 卸载时 Inno 会按日志把 Path 还原成安装前的值；[Code] 里另有一道兜底。
[Registry]
Root: HKLM; Subkey: "SYSTEM\CurrentControlSet\Control\Session Manager\Environment"; ValueType: expandsz; ValueName: "Path"; ValueData: "{olddata};{app}"; Tasks: addtopath; Check: NeedsAddPath(ExpandConstant('{app}')); Flags: preservestringtype

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "运行 {#MyAppName}"; Flags: nowait postinstall skipifsilent runasoriginaluser

[Code]
const
  EnvKey = 'SYSTEM\CurrentControlSet\Control\Session Manager\Environment';

{ 去掉首尾空格和结尾的反斜杠，再统一成大写，方便比较 }
function Canon(const S: string): string;
begin
  Result := Trim(S);
  while (Length(Result) > 0) and (Result[Length(Result)] = '\') do
    Delete(Result, Length(Result), 1);
  Result := Uppercase(Result);
end;

{ PATH 里是不是已经有这个目录了 }
function PathHasDir(const Path, Dir: string): Boolean;
var
  Rest, Item, Target: string;
  P: Integer;
begin
  Result := False;
  Target := Canon(Dir);
  Rest := Path;
  while Rest <> '' do
  begin
    P := Pos(';', Rest);
    if P = 0 then
    begin
      Item := Rest;
      Rest := '';
    end
    else
    begin
      Item := Copy(Rest, 1, P - 1);
      Delete(Rest, 1, P);
    end;
    if Canon(Item) = Target then
    begin
      Result := True;
      exit;
    end;
  end;
end;

{ 安装时用：返回 True 才写注册表，避免重复添加 }
function NeedsAddPath(Param: string): Boolean;
var
  OrigPath: string;
begin
  if not RegQueryStringValue(HKEY_LOCAL_MACHINE, EnvKey, 'Path', OrigPath) then
  begin
    Result := True;
    exit;
  end;
  Result := not PathHasDir(OrigPath, Param);
end;

{ 把某一条从 PATH 里摘掉，其他条目（含空条目）原样保留 }
function RemoveDirFromPath(const Path, Dir: string): string;
var
  Rest, Item, Acc, Target: string;
  P: Integer;
  First: Boolean;
begin
  Target := Canon(Dir);
  Acc := '';
  First := True;
  Rest := Path;
  while Rest <> '' do
  begin
    P := Pos(';', Rest);
    if P = 0 then
    begin
      Item := Rest;
      Rest := '';
    end
    else
    begin
      Item := Copy(Rest, 1, P - 1);
      Delete(Rest, 1, P);
    end;
    if Canon(Item) <> Target then
    begin
      if not First then Acc := Acc + ';';
      Acc := Acc + Item;
      First := False;
    end;
  end;
  Result := Acc;
end;

{ 卸载兜底：万一 Inno 没把 Path 还原，这里自己把目录摘掉 }
procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  Path, NewPath: string;
begin
  if CurUninstallStep = usUninstall then
  begin
    if RegQueryStringValue(HKEY_LOCAL_MACHINE, EnvKey, 'Path', Path) then
    begin
      NewPath := RemoveDirFromPath(Path, ExpandConstant('{app}'));
      if NewPath <> Path then
        RegWriteExpandStringValue(HKEY_LOCAL_MACHINE, EnvKey, 'Path', NewPath);
    end;
  end;
end;
