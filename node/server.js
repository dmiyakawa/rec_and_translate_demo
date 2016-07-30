//
// 事前にpki/server.{crt,key}に証明書・秘密鍵を共有しておくこと
//
'use strict';

var async     = require('async');
var exec      = require('child_process').exec;
var fs        = require('fs');
var google    = require('googleapis');
var https     = require('https');
var socket_io = require('socket.io');

// 2016-07-30時点のβ版を使用する
var speech = google.speech('v1beta1').speech;

var SOX_CMD_PATH = '/usr/bin/sox'

var SSL_KEY  = 'pki/server.key';
var SSL_CERT = 'pki/server.crt';

var PORT  = 12443;

// trueにすると、一時ファイルを消さなくなるなど、デバッグ用の挙動に変わる
var DEBUG = false;

var MSG_RECOGNITION_REQUEST = 'recognition_request';
var MSG_RECOGNITION_RESULT  = 'recognition_result';

function getRandomString(length) {
  var chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  var ret = "";
  for (var i = 0; i < length; i++){
    ret += chars[ Math.floor(Math.random() * chars.length)];
  }
  return ret;
}

function main() {
  console.log("main()");
  var options = {
    key:  fs.readFileSync(SSL_KEY).toString(),
    cert: fs.readFileSync(SSL_CERT).toString()
  };
  
  var app = https.createServer(options);
  var io  = socket_io.listen(app);
 
  app.listen(PORT, "0.0.0.0");

  // Cloud Speech APIへ送る前の中間ファイル名(wav, flac)に使用する
  var random_string = getRandomString(8);
  var path_prefix = "/tmp/audio_" + random_string + "_";
  var audio_index = 1;

  console.log("Start listening port " + PORT);

  io.sockets.on('connection', function(socket) {
    var remote_address = socket.request.connection.remoteAddress;
    if (remote_address) {
      console.log("New connection from \"" + remote_address + "\"");
    } else {
      console.log("New connection");
    }
  
    socket.on(MSG_RECOGNITION_REQUEST, function(res) {
      console.log("Obtained request from a client");
      // クライアントからこの録音のインデックスを受け取り、
      // 返送時にそのままクライアントに返す。
      var request_index;
      var msg;
      if (res.request_index) {
        console.log("request_index: " + res.request_index);
        request_index = res.request_index;
      } else {
        console.log("Failed to obtain request_index.");
        msg = {request_index: null,
               result: "failed",
               reason: "No request_index available"}
        socket.emit(MSG_RECOGNITION_RESULT, msg);
        return;
      }
      var base64_data = res.base64;
      if (!base64_data) {
        msg = {request_index: request_index,
               result: "failed",
               reason: "No base64 data obtained"}
        socket.emit(MSG_RECOGNITION_RESULT, msg);
        return;
      }
      // Cloud Speech APIへ送る際に一時的に作成される音声ファイル
      // DEBUGがfalseの場合、音声認識結果をクライアントに返答後に削除される
      // DEBUGがtrueの場合、ファイルシステムに残る
      var wav_path  = path_prefix + audio_index + ".wav"
      var flac_path = path_prefix + audio_index + ".flac"
      audio_index++;
      async.waterfall([
        function(callback) {
          // クライアントから送られてきたbase64形式のwaveファイルを
          // ローカルファイルとして保存する
          var buf = new Buffer(base64_data, 'base64');
          console.log("Saving wav file \"" + wav_path + "\"");
          fs.writeFile(wav_path, buf, function(err) {
            if (err) {
              console.log(err);
              callback(err);
            } else {
              console.log("Wav file \"" + wav_path + "\" was saved.");
              callback(null, wav_path, flac_path);
            }
          });
        },
        function(wav_path, flac_path, callback) {
          // 保存したwavファイルをflacファイルに変換し、ローカルに保存する
          // 変換は外部コマンド(sox)を使用する
          exec(SOX_CMD_PATH + " \"" + wav_path + "\" --rate 16k --bits 16 --channels 1 \""
             + flac_path + "\"",
             function(error, stdout, stderr) {
               if (error !== null) {
                 console.log("exec error: " + error);
                 callback(error);
               }
               console.log("Flac file \"" + flac_path + "\" created.")
               callback(null, flac_path);
             });
        },
        function(flac_path, callback) {
          // flacファイルを読み込みbase64エンコードし、
          // Cloud Speech APIへ送るためのJSONペイロードを作成する。
          fs.readFile(flac_path, function (err, audio_file) {
            if (err) {
              console.log("Failed to read file \"" + flac_path + "\"");
              return callback(err);
            }
            var encoded = new Buffer(audio_file).toString('base64');
            var request_payload = {
              config: {
                encoding: 'FLAC',
                sampleRate: 16000,
                languageCode: "ja-JP"
              },
              audio: {
                content: encoded
              }
            };
            return callback(null, request_payload);
          });
        },
        function(request_payload, callback) {
          // GoogleのAPIが使えるようにクライアントを準備する
          google.auth.getApplicationDefault(function (err, authClient) {
            if (err) {
              return callback(err);
            }
        
            if (authClient.createScopedRequired && authClient.createScopedRequired()) {
              authClient = authClient.createScoped([
                'https://www.googleapis.com/auth/cloud-platform'
              ]);
            }
            return callback(null, authClient, request_payload);
          });
        },
        function sendRequest(auth_client, request_payload, callback) {
          // Cloud Speech APIにリクエストを送信する
          console.log('Request actual analysis with syncrecognize API');
          speech.syncrecognize({
            auth: auth_client,
            resource: request_payload
          }, function (err, result_json) {
            var error_reason;
            var msg;
            if (err) {
              error_reason = "Speech analysis failed (" + err + ")";
              msg = {request_index: request_index,
                     result: "failed",
                     reason: error_reason}
              socket.emit(MSG_RECOGNITION_RESULT, msg);
              return callback(error_reason);
            }
            
            console.log("Result JSON: \n", JSON.stringify(result_json, null, 2));

            if (!result_json || !result_json["results"]) {
              error_reason = "Failed to parse returned JSON payload.";
              msg = {request_index: request_index,
                     result: "failed",
                     reason: error_reason}
              socket.emit(MSG_RECOGNITION_RESULT, msg);
              return callback(error_reason);
            }
            var result = result_json["results"][0]["alternatives"][0]
            if (result.confidence < 0.5) {
              error_reason = "Confidence too low (" + result.confidence + ")";
              msg = {request_index: request_index,
                     result: "failed",
                     reason: error_reason}
              socket.emit(MSG_RECOGNITION_RESULT, msg);
              return callback(error_reason);
            }
            return callback(null, result.transcript);
          });
        },
        function (transcript, callback) {
          console.log("Send resultant transcript \"" + transcript + "\" to client");
          var msg = {request_index: request_index,
                     result: "successful",
                     transcript: transcript}
          socket.emit(MSG_RECOGNITION_RESULT, msg);
          callback(null);
        }
      ], function(err) {
        if (err) {
          console.error("Error occured during handling record_result request...");
          console.error(err);
        } else {
          console.log("Finished all the work successfully.");
        }
        if (!DEBUG) {
          try {
            fs.unlinkSync(wav_path);
            console.log("Removed " + wav_path);
          } catch (err) {
          }
          try {
            fs.unlinkSync(flac_path);
            console.log("Removed " + flac_path);
          } catch (err) {
          }
        }
      })  // async.waterfall()
    });
   
    socket.on('disconnect', function() {
      console.log("Client disconnected");
    });
  });
}

main();
