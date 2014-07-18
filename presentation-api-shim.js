/**
 * @fileOverview Shim for the latest version of the Presentation API [1] that
 * aims to support projecting to Chromecast devices, to attached devices (HDMI,
 * Miracast, etc.) through the experimental Chromium build [2] and to a separate
 * browser window as a fallback.
 *
 * Support for Chromecast devices is heavily restrained because Cast receiver
 * applications need to be registered with Google before they may be used and
 * this code needs to know about the mapping between the URL of the application
 * and the application ID provided by Google upon registration.
 *
 * As such, applications that want to make use of the shim on Google Cast
 * devices need first to issue a call to:
 *  navigator.presentation.registerCastApplication(appUrl, appId)
 *
 * Other restrictions:
 * - the code uses Promises, underlying Web browser needs to support them
 * - support for custom events is fairly limited. Only the "on" properties
 * are supported to attach to events on exposed objects, no way to use
 * "addEventListener" for the time being.
 * - The Cast sender library [3] needs to be loaded before that code if one
 * wants to support Chromecast devices.
 * - the "onavailablechange" event is not implemented
 * - the code probably does not properly handle cases where the receiver calls
 *  "session.close()". Not exactly sure what to do there.
 *
 * [1] http://webscreens.github.io/presentation-api/
 * [2] http://webscreens.github.io/demo/#binaries
 * [3] https://www.gstatic.com/cv/js/sender/v1/cast_sender.js
 */
(function () {

  /**
   * Whether the Cast API library is available or not.
   * If it's not, the shim simpy fallbacks to window.open with the
   * "presentation" feature.
   */
  var castApiAvailable = false;

  /**
   * Whether the Cast API library has been initialized.
   *
   * That flag is used to support multiple calls to "requestSession". Once
   * the Cast API library has been initialized, subsequent Cast session requests
   * should directly call sessionRequest.
   */
  var castApiInitialized = false;

  /**
   * Mapping table between receiver application URLs and Cast application IDs
   *
   * Ideally, there should not be any need to maintain such a mapping table but
   * there is no way to have an arbitrary URL run on a Chromecast device.
   */
  var castApplications = {};


  /**
   * Wraps an inner Google Cast session, expose useful properties and methods
   * for that session to be used within a PresentationSession.
   *
   * @constructor
   * @param {String} url Receiver application URL
   * @param {chrome.cast.Session} session The running Cast session to wrap
   */
  var CastSession = function (url, session) {
    this.url = url;
    this.state = 'connected';
    this.onstatechange = null;
    this.onmessage = null;
    this.session = session;

    var that = this;
    this.session.addUpdateListener(function (isAlive) {
      that.state = isAlive ? 'connected' : 'disconnected';
      if (that.onstatechange) {
        that.onstatechange(that.state);
      }
    });

    var namespace = this.session.namespaces[0];
    this.session.addMessageListener(namespace, function (namespace, message) {
      if (that.onmessage) {
        that.onmessage(message);
      }
    });
  };


  /**
   * Sends a message to the Google Cast device.
   *
   * @function
   * @param {Object} message
   */
  CastSession.prototype.postMessage = function (message) {
    if (this.state !== 'connected') {
      return;
    }
    var namespace = this.session.namespaces[0];
    this.session.sendMessage(namespace.name, message);
  };


  /**
   * Close the Cast session
   *
   * @function
   */
  CastSession.prototype.close = function () {
    if (this.state !== 'connected') {
      return;
    }
    this.session.stop();
  };


  /**
   * Creates a Google Cast session for the given presentation URL
   *
   * @function
   * @static
   * @param {String} url The URL of the receiver app to run
   * @return {Promise} The promise to have a running Cast session
   */
  CastSession.create = function (url) {
    return new Promise(function (resolve, reject) {
      if (!castApiAvailable) {
        reject();
        return;
      }

      if (!castApplications[url]) {
        reject();
        return;
      }

      var sessionCreated = false;
      var applicationId = castApplications[url];
      var sessionRequest = new chrome.cast.SessionRequest(applicationId);

      var requestSession = function () {
        console.log('request Cast session');
        chrome.cast.requestSession(function (session) {
          console.log('got a new Cast session');
          sessionCreated = true;
          resolve(new CastSession(url, session));
        }, function (error) {
          if (sessionCreated) {
            return;
          }
          if (error.code === 'cancel') {
            console.info('User chose not to use Cast device');
          }
          else if (error.code === 'receiver_unavailable') {
            console.info('No compatible Cast device found');
          }
          else {
            console.error('Could not create Cast session', error);
          }
          reject();
        }, sessionRequest);
      };

      var apiConfig = new chrome.cast.ApiConfig(
        sessionRequest,
        function sessionListener(session) {
          // Method called at most once after initialization if a running
          // Cast session may be resumed
          console.log('Cast session already exists, reusing');
          sessionCreated = true;
          resolve(new CastSession(url, session));
        },
        function receiverListener(available) {
          // Method called whenever the number of Google Cast devices available
          // on the local network changes. The method is called at least once
          // after initialization. We're interested in that first call.
          if (sessionCreated) {
            console.log('receiver listener called after session creation');
            return;
          }

          // Reject creation if there are no Google Cast devices that
          // can handle the application.
          if (available !== chrome.cast.ReceiverAvailability.AVAILABLE) {
            console.log('no Cast device available');
            reject();
          }

          requestSession();
        });

      if (castApiInitialized) {
        // The Cast API library has already been initialized, call
        // requestSession directly.
        requestSession();
      }
      else {
        // The Cast API library first needs to be initialized
        chrome.cast.initialize(apiConfig, function () {
          // Note actual session creation is handled by callback functions
          // defined above
          console.log('Cast API initialized');
          castApiInitialized = true;
        }, function (err) {
          console.error('Cast API could not be initialized', err);
          reject();
          return;
        });
      }
    });
  };


  /**
   * Represents a session to some attached screen, meaning a session to a
   * secondary browsing context created and maintained by the current user
   * agent
   *
   * @constructor
   * @param {window} remoteWindow Pointer to the remote window
   */
  var AttachedSession = function (remoteWindow) {
    this.state = 'connected';
    this.onmessage = null;
    this.onstatechange = null;
    this.remoteWindow = remoteWindow;

    var that = this;

    window.addEventListener('message', function (event) {
      if (event.source === remoteWindow) {
        if (event.data === 'receivershutdown') {
          that.state = 'disconnected';
          if (that.onstatechange) {
            that.onstatechange(that.state);
          }
        }
        else {
          if (that.onmessage) {
            that.onmessage(event.data);
          }
        }
      }
    }, false);
  };


  /**
   * Sends a message to the attached screen
   *
   * @function
   * @param {String} msg
   */
  AttachedSession.prototype.postMessage = function (msg) {
    this.remoteWindow.postMessage(msg, '*');
  };


  /**
   * Closes the attached session
   *
   * @function
   */
  AttachedSession.prototype.close = function () {
    if (this.state !== 'connected') {
      return;
    }
    this.remoteWindow.close();
    this.state = 'disconnected';
    if (this.onstatechange) {
      this.onstatechange(this.state);
    }
  };


  /**
   * Create a presentation session for the first attached screen, falling
   * back to a separate window if there are none.
   *
   * @function
   * @param {String} url The URL to load in the presentation session
   * @return {Promise} The promise to have an AttachedSession instance
   */
  AttachedSession.create = function (url) {
    return new Promise(function (resolve, reject) {
      var presentationWindow = window.open(url, '', 'presentation');
      if (!presentationWindow) {
        reject();
        return;
      }

      window.addEventListener('message', function (event) {
        if ((event.source === presentationWindow) &&
            (event.data === 'receiverready')) {
          presentationWindow.postMessage('presentation', '*');
          resolve(new AttachedSession(presentationWindow));
        }
      }, false);
    });
  };


  /**
   * Presentation session
   *
   * A presentation session is a wrapper class that either embeds a CastSession
   * or an AttachedSession (for lack of better names).
   *
   * @constructor
   * @param {String} url The URL of the application to project
   */
  var PresentationSession = function (url) {
    this.url = url;
    this.session = null;
    this.state = 'disconnected';
    this.onmessage = null;
    this.onstatechange = null;

    // Try with a Google Cast session first,
    // then with an attached session.
    var that = this;
    CastSession.create(url)
      .then(function (session) {
        return session;
      }, function () {
        return AttachedSession.create(url);
      })
      .then(function (session) {
        that.session = session;
        that.state = session.state;
        that.session.onmessage = function (message) {
          if (that.onmessage) {
            that.onmessage(message);
          }
        };
        that.session.onstatechange = function (state) {
          that.state = state;
          if (that.onstatechange) {
            that.onstatechange();
          }
        };
        if (that.state === 'connected') {
          if (that.onstatechange) {
            that.onstatechange();
          }
        }
      });
  };


  /**
   * Sends a message to the wrapped cast or attached session
   *
   * @function
   * @param {*} message
   */
  PresentationSession.prototype.postMessage = function (message) {
    if (!this.session) {
      console.log('Presentation session not available, cannot send message');
      return;
    }
    if (this.state === 'disconnected') {
      console.log('Presentation session is disconnected, cannot send message');
      return;
    }
    this.session.postMessage(message);
  };


  /**
   * Close the session
   */
  PresentationSession.prototype.close = function () {
    if (!this.session) {
      return;
    }
    this.session.close();
    this.session = null;
  };


  /**
   * Presentation receiver session that runs on a Google Cast Cast device.
   *
   * @constructor
   * @param {chrome.cast.CastReceiverManager} castReceiverManager The Cast
   *   receiver manager singleton
   */
  var CastReceiverSession = function (castReceiverManager) {
    this.state = 'connected';
    this.onmessage = null;
    this.onstatechange = null;

    this.castReceiverManager = castReceiverManager;
    this.customMessageBus = castReceiverManager.getCastMessageBus(
      'urn:x-cast:org.w3.webscreens.presentationapi.shim',
      cast.receiver.CastMessageBus.MessageType.JSON);

    var that = this;
    this.customMessageBus.addEventListener('message', function (event) {
      if (that.onmessage) {
        that.onmessage(event.data);
      }
    });
  };


  /**
   * Posts a message from a Cast receiver session to the sender.
   *
   * Note current implementation does not support multiple senders and
   * will just broadcast the message to all connected senders.
   *
   * @function
   * @param {Object} message Message to change
   */
  CastReceiverSession.prototype.postMessage = function (message) {
    if (this.state !== 'connected') {
      return;
    }
    this.customMessageBus.broadcast(message);
  };


  /**
   * Closes the receiver session
   *
   * TODO: this actually kills the application. Not really sure what the
   * function should do instead: close the communication channel? That would
   * leave the presentation session running on the Cast device without
   * controller.
   *
   * @function
   */
  CastReceiverSession.prototype.close = function () {
    if (this.state !== 'connected') {
      return;
    }
    this.state = 'disconnected';
    this.castReceiverManager.stop();
  };



  /**
   * Implements the Presentation API
   *
   * TODO: the "onavailablechange" event is not yet implemented, mostly because
   * it should depend on the URL of the application that will be presented.
   */
  var Presentation = function () {
    this.onavailablechange = null;
    this.onpresent = null;

    var that = this;

    // Initializes presentation receiver bindings. 3 cases arise:
    // 1. shim is running on a Google Cast device, trigger the "onpresent" event
    // as soon as Cast receiver manager is started. Note the opened
    // communication channel expects JSON messages.
    // 2. shim is running in presentation session, wait for the opener
    // to send a "presentation" message before triggering the "present" event
    // 3. shim in running in regular Web app, no need to trigger an "onpresent"
    // event (but that case is essentially the same as 2. from a code
    // perspective)
    var startCastReceiverManager = function () {
      var castReceiverManager = null;
      var session = null;

      castReceiverManager = cast.receiver.CastReceiverManager.getInstance();
      session = new CastReceiverSession(castReceiverManager);
      castReceiverManager.start();
      castReceiverManager.onReady = function () {
        if (that.onpresent) {
          that.onpresent({
            session: session
          });
        }
      };
    };

    // Tell the opener that we're ready and wait for it to send a
    // "presentation" event. That will be a clear indication that the shim
    // is running within a receiver application.
    var waitForPresentationEvent = function () {
      var messageEventListener = function (event) {
        if ((event.source === window.opener) &&
            (event.data === 'presentation')) {
          window.removeEventListener('message', messageEventListener);
          if (that.onpresent) {
            that.onpresent({
              session: new AttachedSession(window.opener)
            });
          }
        }
      };
      window.addEventListener('message', messageEventListener, false);
      window.addEventListener('load', function () {
        if (window.opener) {
          window.opener.postMessage('receiverready', '*');
        }
      });
      window.addEventListener('unload', function () {
        if (window.opener) {
          window.opener.postMessage('receivershutdown', '*');
        }
      });
    };

    // NB: no better way to tell whether we're running on a Google Cast device
    // for the time being, see:
    // https://code.google.com/p/google-cast-sdk/issues/detail?id=157
    var runningOnChromecast = !!window.navigator.userAgent.match(/CrKey/);
    if (runningOnChromecast) {
      startCastReceiverManager();
    }
    else {
      waitForPresentationEvent();
    }
  };


  /**
   * Requests display of web content on a connected screen
   *
   * @function
   * @param {String} url The URL to display on a connected screen
   */
  Presentation.prototype.requestSession = function (url) {
    return new PresentationSession(url);
  };


  /**
   * Non-standard function exposed so that this shim may know how to map
   * a URL to be presented to a Cast receiver application on a Chromecast
   * device
   *
   * @function
   * @param {String} url URL of the receiver application
   * @param {String} id The Cast application ID associated with that URL
   */
  Presentation.prototype.registerCastApplication = function (url, id) {
    castApplications[url] = id;
  };


  // Expose the Presentation API to the navigator object
  navigator.presentation = new Presentation();


  // Initialize the Cast library, if available
  window['__onGCastApiAvailable'] = function(loaded, errorInfo) {
    if (loaded) {
      castApiAvailable = true;
    } else {
      console.log(errorInfo);
    }
  };

}());