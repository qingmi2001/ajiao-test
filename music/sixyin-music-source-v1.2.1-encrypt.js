我想开发一个APK，直接在APK内部打开web页面，以下是我的main.dart文件内容：
import 'package:flutter/material.dart';
import 'package:webview_flutter/webview_flutter.dart';
import 'package:webview_flutter_android/webview_flutter_android.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();

  if (WebViewPlatform.instance is AndroidWebViewPlatform) {
    AndroidWebViewPlatform.registerWith();
  }

  runApp(const MusicWebViewApp());
}

class MusicWebViewApp extends StatelessWidget {
  const MusicWebViewApp({Key? key}) : super(key: key);

  @override
  Widget build(BuildContext context) {
    final WebViewController controller = WebViewController()
      ..setJavaScriptMode(JavaScriptMode.unrestricted)
      ..setBackgroundColor(const Color(0x00000000))
      ..setNavigationDelegate(
        NavigationDelegate(
          onProgress: (int progress) {
            // ...
          },
          onPageStarted: (String url) {},
          onPageFinished: (String url) {
            // 网页加载完成后打印，确认加载状态
            print('WebView Finished Loading: $url');
          },
          onWebResourceError: (WebResourceError error) {
            // 打印任何网络或资源错误
            print('WebResourceError: ${error.description}');
          },
        ),
      )
      ..loadRequest(Uri.parse('https://music.nmlyzx.com'));

    return MaterialApp(
      title: '音乐',
      debugShowCheckedModeBanner: false,
      theme: ThemeData(
        primarySwatch: Colors.blue,
      ),
      home: Scaffold(
        appBar: AppBar(
          title: const Text('音乐'),
        ),
        // **关键点：WebViewWidget 放在 body 中，确保它占用剩余所有空间。**
        body: WebViewWidget(controller: controller),
      ),
    );
  }
}

现在是在android studio中的虚拟机中可以正常打开，但是在实体手机中安装就不能正常使用，打开以后只有“音乐”两个字，然后就是全白底，需要解决这个问题，修改内容，给出完整带啊
