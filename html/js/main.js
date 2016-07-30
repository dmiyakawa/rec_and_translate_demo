window.URL = window.URL || window.webkitURL;
navigator.getUserMedia = navigator.getUserMedia || navigator.webkitGetUserMedia || 
                         navigator.mozGetUserMedia || navigator.msGetUserMedia;
window.AudioContext = window.AudioContext || window.webkitAudioContext;

var now = window.performance && (
    performance.now || performance.mozNow || performance.msNow ||
    performance.oNow || performance.webkitNow
);

window.getTime = function() {
  return (now && now.call(performance)) ||
    (new Date().getTime());
}

window.requestAnimationFrame = (function() {
  return window.requestAnimationFrame ||
    window.webkitRequestAnimationFrame ||
    window.mozRequestAnimationFrame ||
    window.msRequestAnimationFrame ||
    window.oRequestAnimationFrame ||
    function(f) { return window.setTimeout(f, 1000 / 60); };
}());

window.cancelAnimationFrame = (function() {
  return window.cancelAnimationFrame ||
    window.cancelRequestAnimationFrame ||
    window.webkitCancelAnimationFrame ||
    window.webkitCancelRequestAnimationFrame ||
    window.mozCancelAnimationFrame ||
    window.mozCancelRequestAnimationFrame ||
    window.msCancelAnimationFrame ||
    window.msCancelRequestAnimationFrame ||
    window.oCancelAnimationFrame ||
    window.oCancelRequestAnimationFrame ||
    function(id) { window.clearTimeout(id); };
}());

var Main = (function() {
  var MAX_RECORD_TIME_MILLIS = 60 * 1000;
  var INTERVAL_MILLIS = 100;
  var MAX_LOUDNESS_COUNTER = 3;
  var MAX_SILENCE_COUNTER = 10;

  var MSG_RECOGNITION_REQUEST = 'recognition_request';
  var MSG_RECOGNITION_RESULT  = 'recognition_result';

  var intervalId = null;
  
  var visualCanvas = null;
  var visualContext = null;
  
  var audioContext = null;
  var analyser = null;
  var delay = null
  var recorder = null;
  var isRecording = false;
  
  var timerRequestId = null;
  var recordedTimeMillis = 0;
  var previousTimeMillis = 0;

  var loudnessCounter = 0;
  var silenceCounter = 0;
  
  // socket.io
  var socket = null;
  var socketReady = false;

  var request_index = 1;
  
  function init(_socket_hostname, _socket_port) {
    console.log("init(" + _socket_hostname
                + ", " + _socket_port + ")");

    // socket.ioのセットアップ
    if (!initSocketIo(_socket_hostname, _socket_port)) {
      alert("Failed to initialize socket.io");
      return;
    }

    // オーディオ関連とビジュアライザの初期化
    audioContext = new AudioContext();
    analyser = audioContext.createAnalyser();
    analyser.fftSize = 256;
  
    delay = audioContext.createDelay()
  
    visualCanvas = document.getElementById('visual');
    visualContext = visualCanvas.getContext('2d');
  
    if (!navigator.getUserMedia) {
      alert("WebRTC(getUserMedia) is not supported.");
      return;
    }
  
    navigator.getUserMedia({video: false, audio: true}, function(stream) {
      var input = audioContext.createMediaStreamSource(stream);
  
      // 600ms 遅延状態で録音する
      delay.delayTime.value = 0.6;
      input.connect(delay);
      recorder = new Recorder(delay, {workerPath: 'js/recorderjs/recorderWorker.js'});
      if (!recorder) {
        alert("Failed to create Recorder object");
        return;
      }

      input.connect(analyser)
      startInterval();
    }, function() {
      alert("getUserMedia() failed");
    });
  }

  function initSocketIo(hostname, port) {
    if (typeof io == 'undefined' || !io) {
      console.error("socket.io on client side is not ready. ");
      return false;
    }
    var url = 'https://' + hostname + ':' + port + '/';
    console.log("Connecting to socket.io at \"" + url + "\"");
    socket = io.connect(url);
    socket.on('connect', onSocketOpened)
      .on(MSG_RECOGNITION_RESULT, onRecognitionResultReceived)
    return true;
  }

  function onSocketOpened(evt) {
    console.log('socket opened.');
    socketReady = true;
  }
  
  function onRecognitionResultReceived(evt) {
    console.log('onRecognitionResultReceived(' + JSON.stringify(evt) + ')');
    var returned_request_index = evt.request_index;
    if (evt.result === "successful") {
      var transcript = evt.transcript;
      $('#timeline li#record_' + returned_request_index)
        .append('<br><span class="transcript">「' + transcript + '」</span>');
    } else {
      $('#timeline li#record_' + returned_request_index)
        .append('<br><span class="transcript_failed">(Failed to obtain transcript)</span>');
    }
  }


  function onInterval() {
    if (!analyser) {
      return;
    }
  
    visualContext.fillStyle = "rgb(0,0,0)";
    visualContext.fillRect(0, 0, analyser.fftSize, 256);
  
    var data = new Uint8Array(256);
    analyser.getByteTimeDomainData(data);
    // 絶対値を加算してしきい値を設定する
    // (音声解析として正確な処理ではない)
    var accum = 0;
    for (var i = 0; i < 256; ++i) {
      visualContext.fillStyle = "rgb(0,255,0)"
      visualContext.fillRect(i, 256 - data[i], 1, 2);
      // 128 ... 何も音がないとき
      accum += Math.abs(data[i] - 128);
    }
    if (isRecording) {
      if (accum > 1000) {
        // うるさくなったらリセット
        silenceCounter = 0;
      } else {
        silenceCounter++;
        if (silenceCounter >= MAX_SILENCE_COUNTER) {
          stopRecordingWithExport();
          loudnessCounter = 0;
        }
      }
    } else {
      if (accum > 1000) {
        loudnessCounter += 1;
        if (loudnessCounter >= MAX_LOUDNESS_COUNTER) {
          startRecording();
          silenceCounter = 0;
        }
      } else {
        // 静かになったらリセット
        loudnessCounter = 0;
      }
    }
  }
  
  function startInterval() {
    if (intervalId) {
      console.warn("startInterval() ignored; intervalId already exists(" + intervalId + ")");
      return;
    }
    console.log("startInterval()");
  
    intervalId = setInterval(onInterval, INTERVAL_MILLIS);
  }
  
  function stopInterval() {
    if (!intervalId) {
      console.warn("stopInterval() ignored; no intervalId available.");
      return;
    }
    console.log("stopInterval()");
  
    clearInterval(intervalId);
    intervalId = null;
  }
  
  function startRecording() {
    if (isRecording) {
      console.warn("startRecording() ignored; already started recording.");
      return;
    }
    console.log("startRecording()");
    
    isRecording = true;
    startRecordTimer();
    
    recorder.record();
  }

  function stopRecording() {
    if (!isRecording) {
      console.warn("stopRecording() ignored; recording not started yet")
      return;
    }
    console.log("stopRecording()");
  
    stopRecordTimer();
    isRecording = false;
  
    recorder.stop();
  }

  function stopRecordingWithExport() {
    stopRecording();
    recorder.exportWAV(onWavExported);
  }
  
  function onWavExported(blob) {
    console.log("onWavExported()");
    var url = URL.createObjectURL(blob);
    var date = new Date();
    var filename =  date.toISOString() + '.wav';

    var current_request_index = request_index++;

    $('#timeline').append(
      '<li id="record_' + current_request_index + '" class="record">'
      + filename
      + ' <a onclick="Main.playWavBlob(\'' + url + '\');">'
      + '<span class="glyphicon glyphicon-play"></span></a>'
      + ' <a href="' + url + '" download="' + filename + '">'
      + '<span class="glyphicon glyphicon-save"></span></a>'
      + '</li>');
    resetRecordTimer();
    recorder.clear();

    if (socketReady) {
      var reader = new FileReader();
      reader.onload = function() {
        var data_url = reader.result;
        var base64_data = data_url.split(',')[1];
        var request_payload = {request_index: current_request_index,
                               base64: base64_data};
        console.log("Sending a new request to socket.io server");
        socket.emit(MSG_RECOGNITION_REQUEST, request_payload);
        recorder.clear();
      };
      reader.readAsDataURL(blob);
    }
  }
  
  function playWavBlob(url) {
    console.log("playWavBlob(" + url + ")");
    var request = new XMLHttpRequest();
    request.open('GET', url, true);
    request.responseType = 'arraybuffer';
  
    request.onload = function() {
      audioContext.decodeAudioData(request.response, function(buffer) {
        var source = audioContext.createBufferSource();
        source.buffer = buffer;
        source.connect(audioContext.destination);
        source.start(0);
      });
    }
    request.send();
  }
  
  function startRecordTimer() {
    previousTimeMillis = getTime();
    handleRecordTimer();
  }
  
  function handleRecordTimer() {
    var now = getTime();
    recordedTimeMillis += (now - previousTimeMillis);
    previousTimeMillis = now;
    
    updateRecordTimer();
  
    timerRequestId = requestAnimationFrame(handleRecordTimer);
  }
  
  function updateRecordTimer() {
    var percent = Math.floor((recordedTimeMillis / MAX_RECORD_TIME_MILLIS) * 100);
    if (percent >= 100) {
      percent = 100;
      stopRecordingWithExport();
    }
    var ratio = percent / 100.0;
    var color  = 'rgba(' + Math.floor(255*ratio) + ',0,' + Math.floor(255*(1-ratio)) + ',1)';
  
    $('#record_timer').css('width', percent + '%');
    $('#record_timer').css('background-color', color);
  }
  
  
  function stopRecordTimer() {
    if (timerRequestId) {
      cancelAnimationFrame(timerRequestId);
      timerRequestId = null;
    }
  }
  
  function resetRecordTimer() {
    stopRecordTimer();
    recordedTimeMillis = 0;
    updateRecordTimer();
  }

  return {
    init: init,
    playWavBlob: playWavBlob
  };
})();
