# これは何

音声を録音し、サーバ経由でGoogle Cloud Speech APIで音声認識を行い、結果をWebで表示するデモ。

https://mowa-net.jp/demos/rec_and_translate_demo/

## デモの利用方法

Webサイト上でのマイクの利用を許可し、日本語をしゃべる。
一度のおしゃべりは3秒〜1分

最初にwavファイルがダウンロードできるようになり、少ししたら、
そのwavファイルをGoogle Cloud APIで音声認識させた結果が表示される。



## 検証環境

Debian wheesy + node 4.4.7 + npm 2.15.8 にて動作検証

## ファイル構成

* README.md ... このファイル
* html/ ... Apache等から見える位置に置く静的ファイル群
* node/ ... node.jsサーバを実行する上で必要な各種ファイル群


## 解説

以下のデモプロジェクトがベースになっている。

https://github.com/dmiyakawa/webrec_demo

その上で Cloud Speech API を用いて日本語音声を認識して文字列にして表示する。

https://cloud.google.com/speech/

Cloud Speech APIへリクエストを送るためのnode.jsサーバを立てる必要がある。

node.jsサーバはデフォルトで12443番をlistenする。
このサーバはsocket.ioでwavが来るのを待機し、
来たらflac化してCloud Speech APIにリクエストを送り、
結果をブラウザに戻すだけの処理を行う。

今のところHTML上のJavaScriptだけでは完結しないのが課題。

## インストール方法


Node.jsから/usr/bin/soxを実行するので、存在しなければ別途インストールする。

GoogleのDeveloper Consoleで、Cloud Speech APIが有効されたプロジェクトを準備する。

Google Cloud Platform上で実行するのでなければ、
ここでgcloudをインストールし、gcloud initする必要があるかもしれない。

https://cloud.google.com/sdk/docs/#linux

そのプロジェクト内で「サービス アカウント キー」を作成、JSON形式で取得し、
サーバ上に置く。
ここでは、そのJSONファイルを仮に/path/to/account-key-19df4bcf4da1.json とする。

html/ をApache等のWebサーバに設置する。
Webサーバはhttps接続を受け入れるようになっていなければならない。
index.html上のexample.comになっている部分をサーバのホスト名に適切に書き換える。

node/ 下もサーバ上のどこかに設置する。
こちらはWebサーバから見える位置であってはならない。
node/pki/ 配下に適切な server.crt, server.key を設置する。

以上の準備をした上で

    npm install

で成功を確認したら、

    export GOOGLE_APPLICATION_CREDENTIALS=/path/to/account-key-19df4bcf4da1.json
    npm start

なお、この場合node.jsサーバは自動的に再起動したりはしないので、
長期間稼働させるのであれば、適宜自動起動させるといった工夫を行う必要がある。
(ただ、デモの性質上、長時間稼働はあまりおすすめしない)


## ライセンス

Apache-2.0

