# 手机远程文件访问系统

这是一个轻量级的手机远程文件浏览工具。服务端负责提供网页界面，Windows 电脑代理主动连接服务端。手机输入电脑端显示的六位配对码后，即可浏览、搜索和下载电脑中的文件。

## 主要功能

- 电脑代理主动向外连接，无需在电脑上开放公网端口。
- 使用电脑端生成的临时配对码完成手机配对。
- 浏览常用目录和可用磁盘。
- 按名称搜索文件和文件夹。
- 下载文件时显示准备进度。
- 只提供只读访问，不支持删除、移动、上传文件或执行命令。

## 配置服务地址

启动电脑代理前，通过环境变量设置已部署的服务地址：

```powershell
$env:PHONE_REMOTE_SERVER_URL = "https://your-domain.example"
```

也可以把服务地址作为第一个参数传入：

```powershell
node agent/pc-agent.js https://your-domain.example
powershell -NoProfile -ExecutionPolicy Bypass -File agent/pc-agent.ps1 https://your-domain.example
```

使用 WinForms 代理时，将服务地址传给 `PhoneRemoteAgent.exe`：

```powershell
PhoneRemoteAgent.exe https://your-domain.example
```

## 启动服务端

```powershell
npm install
npm start
```

服务端默认监听 `5423` 端口，也可以通过 `PORT` 环境变量修改：

```powershell
$env:PORT = "5423"
npm start
```

正式部署时，建议使用反向代理提供 HTTPS，并将电脑代理的服务地址设置为对应的 HTTPS 地址。

## 构建 Windows 代理

WinForms 代理源码位于 [`agent/PhoneRemoteAgent.cs`](agent/PhoneRemoteAgent.cs)。可以在 Windows 中使用 .NET Framework C# 编译器构建：

```powershell
$csc = "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
& $csc /nologo /target:winexe /platform:anycpu /optimize+ `
  /out:agent\PhoneRemoteAgent.exe `
  /reference:System.Windows.Forms.dll `
  /reference:System.Drawing.dll `
  /reference:System.Web.Extensions.dll `
  agent\PhoneRemoteAgent.cs
```

运行日志和配对身份信息保存在当前 Windows 用户的本地应用数据目录中。

## 安全说明

- 配对码相当于临时密码，请勿发送给不受信任的人。
- 正式部署时必须使用 HTTPS。
- 仅在需要远程访问文件时运行电脑代理。
- 本仓库不包含运行日志、缓存、压缩包、可执行文件、部署专用路径或个人资料。
