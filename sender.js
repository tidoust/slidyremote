/**
 * @fileOverview Code needed to run the HTML Slidy remote demo
 */
window.onload = function () {
  /**
   * Warn user if page is not running in Chrome or Chromium
   */
  if (!navigator.userAgent.match(/Chrome\//) &&
      !navigator.userAgent.match(/Chromium\//)) {
    document.getElementById('nochrome').hidden = false;
  }


  /**
   * Register the Google Cast receiver application to the Presentation API
   * shim so that it knows which application ID to use.
   *
   * Note the first one is for dev purpose and means "same origin" as the one
   * of the page.
   *
   * That step is to disappear when the Presentation API is supported by
   * Google Cast devices.
   */
  var receiverApps = [
    {
      origin: null,
      url: 'receiver.html',
      castId: '06F76BDC'
    },
    {
      origin: 'https://tidoust.github.io',
      url: 'https://tidoust.github.io/slidyremote/receiver.html',
      castId: 'AA65CCFD'
    },
    {
      origin: 'https://www.w3.org',
      url: 'https://www.w3.org/2014/secondscreen/demo/slidyremote/receiver.html',
      castId: '2F330A8F'
    }
  ];
  receiverApps.forEach(function (app) {
    navigator.presentation.registerCastApplication(app.url, app.castId);
  });


  /**
   * Pointer to the projected slide show if there is one
   */
  var presentationSession = null;


  /**
   * Whether the slide show has been projected for real or not
   */
  var presentationSessionConnected = false;


  /**
   * A few references to useful DOM elements
   */
  var formSection = document.getElementById('form');
  var remoteSection = document.getElementById('remote');
  var errorSection = document.getElementById('error');


  /**
   * Handle error messages
   */
  var reportError = function (message) {
    errorSection.querySelector('p').innerHTML = message;
    errorSection.hidden = false;
  };
  errorSection.querySelector('button').addEventListener('click', function (event) {
    errorSection.hidden = true;
    event.preventDefault();
    return false;
  });


  /**
   * Project the Slidy slideshow targeted by the URL entered by the user
   * to a second screen.
   */
  var submitButton = formSection.querySelector('input[type=submit]');
  submitButton.addEventListener('click', function (event) {
    event.preventDefault();

    if (presentationSession) {
      return false;
    }

    // Automatically convert http://www.w3.org into https://www.w3.org URLs
    var enteredUrl = document.querySelector('#url').value;
    if (enteredUrl.match(/^http:\/\/www.w3.org/)) {
      enteredUrl = 'https://' + enteredUrl.substring(7);
    }

    var url = null;
    var baseUrl = null;
    try {
      url = new URL(enteredUrl, document.baseURI);
      baseUrl = new URL(document.baseURI);
    }
    catch (err) {
      reportError('The URL you entered is invalid.' +
        ' Note that if the problem persists while the URL looks correct,' +
        ' your browser may not support the URL constructor.');
      return false;
    }

    var receiverApp = null;
    receiverApps.forEach(function (app) {
      if ((app.origin && (app.origin === url.origin)) ||
          (!app.origin && (url.origin === baseUrl.origin))) {
        receiverApp = app;
      }
    });
    if (!receiverApp) {
      reportError('No HTML Slidy receiver application known for the origin "' +
        url.hostname + '". The demo is typically limited to the origins ' +
        '<code>https://www.w3.org</code> and <code>https://tidoust.github.io</code>');
      return false;
    }
    console.log('Using receiver app "' + receiverApp.url + '" ' +
      '(castId: ' + receiverApp.castId + ')');
    
    // Open the Slidy receiver application on a second screen, on a Chromecast
    // device if one is available, an attached screen if the user uses the
    // appropriate custom Google Chrome build, falling back to a separate
    // window if possible.
    presentationSession = navigator.presentation.requestSession(receiverApp.url);
    presentationSessionConnected = false;

    // Tell our Slidy remote about the created presentation session so that
    // local keystrokes effectively run the appropriate Slidy commands on the
    // remote slide show.
    window.w3c_slidy.bindToPresentationSession(presentationSession);

    // Load the requested slideshow on the receiver end when the session
    // is fully operational and reset things if the session is closed for
    // some reason
    presentationSession.onstatechange = function () {
      if (this.state === 'connected') {
        console.info('Presentation session connected');
        presentationSessionConnected = true;
        window.w3c_slidy.loadSlideshow(url.toString());
        formSection.hidden = true;
        remoteSection.hidden = false;
      }
      else {
        console.warn('Presentation session disconnected');
        if (!presentationSessionConnected) {
          reportError('The presentation session could not be created.' +
            ' Your browser may have blocked the pop-up window.' +
            ' Please ensure that the page is allowed to open pop-up windows' +
            ' and try again.');
        }
        presentationSession = null;
        presentationSessionConnected = false;
        window.w3c_slidy.closePresentation();
        formSection.hidden = false;
        remoteSection.hidden = true;
      }
    };

    return false;
  });


  /**
   * Event handler to close the presentation
   */
  var closePresentation = function (event) {
    if (presentationSession) {
      presentationSession.close();
      presentationSession = null;
      presentationSessionConnected = false;
      window.w3c_slidy.closePresentation();
    }
    formSection.hidden = false;
    remoteSection.hidden = true;
    event.preventDefault();
    return false;
  };



  /**
   * Get pointers to remote buttons
   */
  var remote = {
    close: document.getElementById('remote-off'),
    previous_slide: document.getElementById('remote-previous'),
    next_slide: document.getElementById('remote-next'),
    first_slide: document.getElementById('remote-first'),
    last_slide: document.getElementById('remote-last'),
    smaller: document.getElementById('remote-smaller'),
    bigger: document.getElementById('remote-bigger'),
    toggle_table_of_contents: document.getElementById('remote-toc'),
    toggle_toolbar: document.getElementById('remote-footer'),
    toggle_view: document.getElementById('remote-all')
  };


  /**
   * Bind clicks on remote buttons to the appropriate Slidy commands
   */
  Object.keys(remote).forEach(function (command) {
    if (command === 'close') {
      remote[command].addEventListener('click', closePresentation);
    }
    else {
      remote[command].addEventListener('click', function (event) {
        window.w3c_slidy[command]();
      });
    }
  });
};
