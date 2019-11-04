// Class to handle child process used for running FFmpeg

const child_process = require('child_process');
const { EventEmitter } = require('events');

const { createSdpText } = require('./sdp');
const { convertStringToStream } = require('./utils');

var ffmpegExec = require('ffmpeg-static');
console.log(ffmpegExec.path);


const RECORD_FILE_LOCATION_PATH = process.env.RECORD_FILE_LOCATION_PATH || './videos';

module.exports = class FFmpeg {
  constructor (rtpParameters) {
    this._rtpParameters = rtpParameters;
    this._process = undefined;
    this._observer = new EventEmitter();
    this._createProcess();
  }

  _createProcess () {
    const sdpString = createSdpText(this._rtpParameters);
    const sdpStream = convertStringToStream(sdpString);

    console.log('createProcess() [sdpString:%s]', sdpString);

    this._process = child_process.spawn(ffmpegExec.path, this._commandArgs);

    if (this._process.stderr) {
      this._process.stderr.setEncoding('utf-8');

      this._process.stderr.on('data', data =>
        console.log('ffmpeg::process::data [data:%o]', data)
      );
    }

    if (this._process.stdout) {
      this._process.stdout.setEncoding('utf-8');

      this._process.stdout.on('data', data => 
        console.log('ffmpeg::process::data [data:%o]', data)
      );
    }

    this._process.on('message', message =>
      console.log('ffmpeg::process::message [message:%o]', message)
    );

    this._process.on('error', error =>
      console.error('ffmpeg::process::error [error:%o]', error)
    );

    this._process.once('close', () => {
      console.log('ffmpeg::process::close');
      this._observer.emit('process-close');
    });

    sdpStream.on('error', error =>
      console.error('sdpStream::error [error:%o]', error)
    );

    // Pipe sdp stream to the ffmpeg process
    sdpStream.resume();
    sdpStream.pipe(this._process.stdin);
  }

  kill () {
    console.log('kill() [pid:%d]', this._process.pid);
    this._process.kill('SIGINT');
  }

//ffmpeg -i videos/2ok654/00004.webm 
/*
-map 0 
-codec:v libx264 
-codec:a libfaac 
-f ssegment 
-segment_list playlist.m3u8 
-segment_list_flags +live -segment_time 10 out%03d.ts
*/
  get _commandArgs () {
    let commandArgs = [
      '-loglevel',
      'debug',
      '-protocol_whitelist',
      'pipe,udp,rtp',
      '-fflags',
      '+genpts',
      '-f',
      'sdp',
      '-i',
      'pipe:0'
    ];

    /*
    let commandArgs = [
      '-loglevel',
      'debug',
      '-protocol_whitelist',
      'pipe,udp,rtp',
      '-fflags',
      '+genpts',
      '-f',
      'sdp',
      '-i',
      'pipe:0'
    ];
    */
    commandArgs = commandArgs.concat(this._videoArgs);
    commandArgs = commandArgs.concat(this._audioArgs);

    commandArgs = commandArgs.concat([
      //'-profile',
      // 'ultrafast',
       `${RECORD_FILE_LOCATION_PATH}/${this._rtpParameters.fileName}.mp4`
      /*
      '-f',
      'ssegment',
      '-segment_list',
      `${RECORD_FILE_LOCATION_PATH}/playlist.m3u8`,
      '-segment_list_flags',
      '+live',
      '-segment_time',
      '10',
      `${RECORD_FILE_LOCATION_PATH}/out%03d.ts`
      */
      /*
      '-flags',
      '+global_header',
      `${RECORD_FILE_LOCATION_PATH}/${this._rtpParameters.fileName}.webm`
      */
    ]);

    console.log('commandArgs:%o', commandArgs);

    return commandArgs;
  }

  get _videoArgs () {
    return [
      

      //'-map',
      //'0:v:0',
      //'0',
      //'-codec:v','libx264'
            /*
      '-c:v',
      'copy'
      */
    ];
  }

  get _audioArgs () {
    return [
      // '-map',
      // '0:a:0',
      //'-codec:a','libmp3lame'

      /*
      '-strict', // libvorbis is experimental
      '-2',
      '-c:a',
      'copy'
      */
    ];
  }
}
