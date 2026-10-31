; 网易云 163key 标签工具 —— Inno Setup 安装脚本
;
; 编译（由 Build-Release.ps1 自动调用）：
;   ISCC.exe /DMyAppVersion=0.3.1 installer\netease-163key-tagger.iss
;
; 产物：dist\netease-163key-tagger-setup-v<版本>.exe
;
; 风格对齐隔壁的 gacha-link-fetcher（lzma2/ultra64、简体中文向导、可选桌面快捷方式、
; 装完可直接启动），但**安装范围改成了「只给当前用户」**：
;   - PrivilegesRequired=lowest → 全程不弹 UAC、不需要管理员
;   - {autopf} 在这种模式下就是 %LOCALAPPDATA%\Programs，不写 Program Files
;   - PATH 只改 HKCU\Environment（用户 PATH），不动系统 PATH
; 这么改的原因：管理员安装要先在 %TEMP% 解包自己，一旦这一步被环境拒绝就会
; 报「无法创建目录 ...is-XXXX.tmp。错误 5: 拒绝访问」。每用户安装把这一环的
; 权限要求降到最低，普通用户双击就能装。

#ifndef MyAppVersion
  #define MyAppVersion "0.3.1"
#endif

#define MyAppName "网易云 163key 标签工具"
#define MyAppExeName "netease-163key-tagger.exe"
#define MyAppPublisher "H0NG1Y"
#define MyAppUrl "https://github.com/H0NG1Y/netease-163key-tagger"
; v0.3.0 及更早的「管理员装到 Program Files」用的就是同一个 AppId，
; 但卸载信息在 HKLM，和现在的 HKCU 互不认识，所以要靠 InitializeSetup 提醒。
#define MyAppId "{{12459E57-618E-4EBE-A128-5C308608F772}"

[Setup]
AppId={#MyAppId}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppVerName={#MyAppName} v{#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL={#MyAppUrl}
AppSupportURL={#MyAppUrl}/issues
AppUpdatesURL={#MyAppUrl}/releases/latest
; lowest 模式下 {autopf} = %LOCALAPPDATA%\Programs
DefaultDirName={autopf}\netease-163key-tagger
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
OutputDir=..\dist
OutputBaseFilename=netease-163key-tagger-setup-v{#MyAppVersion}
UninstallDisplayIcon={app}\{#MyAppExeName}
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
CloseApplications=yes
RestartApplications=yes
SetupLogging=yes
ChangesAssociations=no
; 改了环境变量就广播 WM_SETTINGCHANGE，让新开的程序立刻认到
ChangesEnvironment=yes
DisableReadyPage=no
AllowNoIcons=yes

[Languages]
Name: "chinesesimp"; MessagesFile: "compiler:Languages\ChineseSimplified.isl"

[Tasks]
Name: "addtopath"; Description: "把安装目录加入用户 PATH（之后可在任意目录直接执行命令）"; GroupDescription: "命令行："
Name: "desktopicon"; Description: "创建桌面快捷方式"; GroupDescription: "附加快捷方式："; Flags: unchecked

[Files]
Source: "..\dist\netease-163key-tagger.exe"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{userprograms}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"
Name: "{userdesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon

; 只追加自己那一条，已经在 PATH 里就不重复加。
; preservestringtype 保住 REG_EXPAND_SZ；ChangesEnvironment 让系统广播环境变量变化。
; 卸载时 Inno 会按日志把 Path 还原成安装前的值；[Code] 里另有一道兜底。
[Registry]
Root: HKCU; Subkey: "Environment"; ValueType: expandsz; ValueName: "Path"; ValueData: "{olddata};{app}"; Tasks: addtopath; Check: NeedsAddPath(ExpandConstant('{app}')); Flags: preservestringtype

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "运行 {#MyAppName}"; Flags: nowait postinstall skipifsilent

[Code]
const
  EnvKey = 'Environment';
  OldUninstallKey = 'SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\{12459E57-618E-4EBE-A128-5C308608F772}_is1';

{ 旧的管理员版装在 Program Files，卸载信息在 HKLM。新版是每用户安装，
  两者互不认识，所以装之前先提醒一句，免得硬盘上留两份。 }
function InitializeSetup(): Boolean;
var
  OldUninst, OldLoc: string;
begin
  Result := True;
  if RegQueryStringValue(HKEY_LOCAL_MACHINE, OldUninstallKey, 'UninstallString', OldUninst) then
  begin
    { 光看残留的注册表项不够：旧版卸载干净了、只剩一个孤儿键的情况很常见，
      那种情况不该打扰用户。只有旧目录真的还在，才值得提醒。 }
    if not RegQueryStringValue(HKEY_LOCAL_MACHINE, OldUninstallKey, 'InstallLocation', OldLoc) then
      OldLoc := ExpandConstant('{commonpf}\{#MyAppName}');
    if DirExists(OldLoc) then
    begin
      { 静默安装（/SILENT /VERYSILENT）不能弹窗挡路，直接按「继续」处理 }
      if not WizardSilent then
      begin
        if MsgBox('检测到之前用管理员权限安装的旧版本（装在 Program Files 下）：' + #13#10 +
                  OldLoc + #13#10 + #13#10 +
                  '新版本改成「只给当前用户安装」：不写 Program Files、不需要管理员。' + #13#10 +
                  '建议先卸载旧版本（设置 → 应用 → 已安装的应用）再继续。' + #13#10 + #13#10 +
                  '现在继续安装吗？', mbConfirmation, MB_YESNO) = IDNO then
          Result := False;
      end;
    end;
  end;
end;

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
  if not RegQueryStringValue(HKEY_CURRENT_USER, EnvKey, 'Path', OrigPath) then
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

{ ── 读 PATH 的真实类型 ───────────────────────────────────────
  安装时 [Registry] 用 preservestringtype 保住了原类型，但卸载兜底是
  我们自己写回去的，必须知道原来是 REG_SZ 还是 REG_EXPAND_SZ，
  否则会把用户的 REG_SZ PATH 无端改成 REG_EXPAND_SZ。
  Inno 的 Reg* 函数只能取值、取不到类型，所以直接问 advapi32。 }
function RegOpenKeyExW(hKey: Integer; lpSubKey: String; ulOptions, samDesired: Cardinal;
  var phkResult: Integer): Integer;
  external 'RegOpenKeyExW@advapi32.dll stdcall';
function RegQueryValueExW(hKey: Integer; lpValueName: String; lpReserved: Integer;
  var lpType: Cardinal; lpData: Integer; var lpcbData: Cardinal): Integer;
  external 'RegQueryValueExW@advapi32.dll stdcall';
function RegCloseKey(hKey: Integer): Integer;
  external 'RegCloseKey@advapi32.dll stdcall';

const
  KEY_QUERY_VALUE = $0001;
  REG_SZ_TYPE = 1;
  REG_EXPAND_SZ_TYPE = 2;

{ 返回 True = 原值是 REG_EXPAND_SZ；读不到类型时按 True 处理（PATH 的推荐类型） }
function PathWasExpandString(): Boolean;
var
  Hk: Integer;
  Typ: Cardinal;
  Cb: Cardinal;
begin
  Result := True;
  if RegOpenKeyExW(HKEY_CURRENT_USER, 'Environment', 0, KEY_QUERY_VALUE, Hk) = 0 then
  begin
    Typ := 0;
    Cb := 0;
    if RegQueryValueExW(Hk, 'Path', 0, Typ, 0, Cb) = 0 then
      Result := (Typ <> REG_SZ_TYPE);
    RegCloseKey(Hk);
  end;
end;

{ 卸载兜底：万一 Inno 没把 Path 还原，这里自己把目录摘掉 }
procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  Path, NewPath: string;
begin
  if CurUninstallStep = usUninstall then
  begin
    if RegQueryStringValue(HKEY_CURRENT_USER, EnvKey, 'Path', Path) then
    begin
      NewPath := RemoveDirFromPath(Path, ExpandConstant('{app}'));
      if NewPath <> Path then
      begin
        if PathWasExpandString() then
          RegWriteExpandStringValue(HKEY_CURRENT_USER, EnvKey, 'Path', NewPath)
        else
          RegWriteStringValue(HKEY_CURRENT_USER, EnvKey, 'Path', NewPath);
      end;
    end;
  end;
end;
