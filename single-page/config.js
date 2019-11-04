module.exports = {
  // http server ip, port, and peer timeout constant
  //
  httpIp: '0.0.0.0',
  httpPort: 3001,
  httpPeerStale: 15000,

  // ssl certs. we'll start as http instead of https if we don't have
  // these
  sslCrt: 'fullchain1.pem',
  sslKey: 'privkey1.pem',
 

  mediasoup: {
    worker: {
      rtcMinPort: 40000,
      rtcMaxPort: 49999,
      logLevel: 'debug',
      logTags: [
        'info',
        'ice',
        'dtls',
        'rtp',
        'srtp',
        'rtcp',
        // 'rtx',
        // 'bwe',
        // 'score',
        // 'simulcast',
        // 'svc'
      ],
    },
    router: {
      mediaCodecs:
        [
          {
            kind: 'audio',
            mimeType: 'audio/opus',
            clockRate: 48000,
            channels: 2
          },
          {
            kind: 'video',
            mimeType: 'video/VP8',
            clockRate: 90000,
            parameters:
              {
//                'x-google-start-bitrate': 1000
              }
          },
          {
					  kind       : 'video',
					  mimeType   : 'video/h264',
					  clockRate  : 90000,
					  parameters :
					  {
						  'packetization-mode'      : 1,
						  'profile-level-id'        : '4d0032',
						  'level-asymmetry-allowed' : 1,
//						  'x-google-start-bitrate'  : 1000
					  }
				  },
				  {
					  kind       : 'video',
					  mimeType   : 'video/h264',
					  clockRate  : 90000,
					  parameters :
					  {
						  'packetization-mode'      : 1,
						  'profile-level-id'        : '42e01f',
						  'level-asymmetry-allowed' : 1,
//						  'x-google-start-bitrate'  : 1000
					  }
				  }
        ]
    },

    // rtp listenIps are the most important thing, below. you'll need
    // to set these appropriately for your network for the demo to
    // run anywhere but on localhost
    webRtcTransport: {
      listenIps: [
{ ip: '172.31.25.107', announcedIp:'34.255.148.107' }, { ip: '127.0.0.1', announcedIp: undefined }
      ],
      initialAvailableOutgoingBitrate: 800000,
    }
  }
};
