window.onload = function () {
  /**
   * Pointer to the "w3c_slidy" object in controlled slideshow
   */
  var controlledSlidy = null;

  /**
   * The controlled slideshow is displayed in a child iframe
   */
  var iframe = document.querySelector('iframe');
  iframe.onload = function () {
    controlledSlidy = iframe.contentWindow.w3c_slidy;
  };

  /**
   * React to the establishment of a new session
   */
  navigator.presentation.onpresent = function (event) {
    var presentationSession = event.session;

    presentationSession.onmessage = function (message) {
      var params = null;
      if (!message || !message.cmd) {
        return;
      }
      if (message.cmd === 'open') {
        console.log('open slideshow at "' + message.url + '"');
        iframe.src = message.url;
      }
      else if (!controlledSlidy) {
        return;
      }
      else {
        // Send command to controlled Slidy
        params = message.params || [];
        controlledSlidy[message.cmd].apply(controlledSlidy, params);
      }
    };
  };
};