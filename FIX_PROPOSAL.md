To fix the issue of chat messages not being cleared between games in the Node version, you need to modify the `server.js` file. 

The exact code fix is to add the following line of code when a game ends:

```javascript
chatMessages = [];
```

Alternatively, you can re-initialize the room state by calling the function that initializes the room state at the start of a new game.

Here's an example of how you can implement this:

```javascript
// When a game ends
function endGame() {
    // Clear chat messages
    chatMessages = [];

    // Re-initialize the room state (if applicable)
    initRoomState();
}

// Initialize room state at the start of a new game
function initRoomState() {
    // Initialize room state properties here
    // ...
}

// Call initRoomState at the start of a new game
function startNewGame() {
    initRoomState();
    // ...
}
```

Make sure to replace `initRoomState()` with the actual function that initializes the room state in your code.

By adding this code, you ensure that the `chatMessages` array is cleared when a game ends, and a new game begins with a fresh chat history.