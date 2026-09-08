; LingoLearn Phonetics — Inno Setup 6
; Builds one Setup .exe you can publish (GitHub Releases, website, USB).

#ifndef AppVersion
  #define AppVersion "2.0.0"
#endif

#ifndef AppName
  #define AppName "LingoLearn Phonetics"
#endif

#ifndef SourceDir
  #define SourceDir "..\dist\win-unpacked"
#endif

#ifndef OutputDir
  #define OutputDir "..\dist"
#endif

#ifndef SetupIcon
  #define SetupIcon "..\installer\icon.ico"
#endif

#define AppExe "LingoLearn Phonetics.exe"
#define AppPublisher "Md. Yamin Hossain"
#define AppURL "https://github.com/needyamin/lingoLearn-phonetics"

[Setup]
AppId={{E7B4A91C-3F62-4D8E-B5A1-9C8E2F4D7A10}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher={#AppPublisher}
AppPublisherURL={#AppURL}
AppSupportURL={#AppURL}/issues
AppUpdatesURL={#AppURL}/releases
DefaultDirName={localappdata}\Programs\LingoLearn Phonetics
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
OutputDir={#OutputDir}
OutputBaseFilename=LingoLearn-Phonetics-Setup-{#AppVersion}
SetupIconFile={#SetupIcon}
UninstallDisplayIcon={app}\app.ico
UninstallDisplayName={#AppName}
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
ArchitecturesAllowed=x64
ArchitecturesInstallIn64BitMode=x64
MinVersion=10.0
AllowNoIcons=yes
CloseApplications=force
RestartApplications=no
UsedUserAreasWarning=no
DisableWelcomePage=no
WizardSizePercent=120
VersionInfoVersion={#AppVersion}.0
VersionInfoCompany={#AppPublisher}
VersionInfoProductName={#AppName}
VersionInfoCopyright=Copyright (C) {#AppPublisher}

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "Create a &desktop shortcut"; GroupDescription: "Additional shortcuts:"; Flags: checkedonce
Name: "startupicon"; Description: "Start {#AppName} when I sign in"; GroupDescription: "Additional shortcuts:"; Flags: unchecked

[Files]
Source: "{#SourceDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\{#AppName}"; Filename: "{app}\{#AppExe}"; IconFilename: "{app}\app.ico"; Comment: "English pronunciation, IPA, and Bangla dictionary"
Name: "{group}\Uninstall {#AppName}"; Filename: "{uninstallexe}"
Name: "{userdesktop}\{#AppName}"; Filename: "{app}\{#AppExe}"; IconFilename: "{app}\app.ico"; Tasks: desktopicon
Name: "{userstartup}\{#AppName}"; Filename: "{app}\{#AppExe}"; IconFilename: "{app}\app.ico"; Tasks: startupicon

[Run]
Filename: "{app}\{#AppExe}"; Description: "Launch {#AppName}"; Flags: nowait postinstall skipifsilent

[UninstallDelete]
Type: filesandordirs; Name: "{app}"

[Code]
function InitializeUninstall(): Boolean;
var
  ResultCode: Integer;
begin
  Exec('taskkill.exe', '/F /IM "LingoLearn Phonetics.exe"', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Result := True;
end;
