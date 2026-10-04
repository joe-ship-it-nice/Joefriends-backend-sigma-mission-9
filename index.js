require("dotenv").config();

const path = require("path");

const express = require("express");
const cors = require("cors");
const createSupabaseClient = require("./supabaseClient");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: "100kb" }));

// Serve files from the public folder.
app.use(express.static(path.join(__dirname, "public")));

// Check whether a value contains text.
function isText(value) {
  return typeof value === "string" && value.trim().length > 0;
}

// Show the API documentation homepage.
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// Create an account.
app.post("/signup", async (req, res) => {
  const { email, password, username } = req.body || {};

  if (!isText(email) || !isText(password) || !isText(username)) {
    return res.status(400).json({
      message: "Email, password, and username are required.",
    });
  }

  const cleanUsername = username.trim();

  if (cleanUsername.length < 3 || cleanUsername.length > 30) {
    return res.status(400).json({
      message: "Username must contain 3 to 30 characters.",
    });
  }

  if (password.length < 8) {
    return res.status(400).json({
      message: "Password must contain at least 8 characters.",
    });
  }

  const supabase = createSupabaseClient();

  const { data, error } = await supabase.auth.signUp({
    email: email.trim().toLowerCase(),
    password,
    options: {
      data: {
        username: cleanUsername,
      },
    },
  });

  if (error) {
    return res.status(400).json({
      message: error.message,
    });
  }

  return res.status(201).json({
    message: data.session
      ? "Account created. You can now log in."
      : "Check your email to confirm your account before logging in.",
  });
});

// Log in and return an authentication token.
app.post("/login", async (req, res) => {
  const { email, password } = req.body || {};

  if (!isText(email) || !isText(password)) {
    return res.status(400).json({
      message: "Email and password are required.",
    });
  }

  const supabase = createSupabaseClient();

  const { data, error } = await supabase.auth.signInWithPassword({
    email: email.trim().toLowerCase(),
    password,
  });

  if (error || !data.session) {
    return res.status(401).json({
      message: "Login failed. Check your credentials and confirm your email.",
    });
  }

  return res.json({
    token: data.session.access_token,
    user: {
      id: data.user.id,
      email: data.user.email,
    },
  });
});

// Check the Bearer token before allowing access.
async function verifyToken(req, res, next) {
  const authorization = req.get("Authorization") || "";
  const match = authorization.match(/^Bearer ([^\s]+)$/i);

  if (!match) {
    return res.status(401).json({
      message: "A Bearer token is required.",
    });
  }

  const token = match[1];
  const supabase = createSupabaseClient();

  const { data, error } = await supabase.auth.getUser(token);

  if (error || !data.user) {
    return res.status(401).json({
      message: "Invalid or expired token.",
    });
  }

  req.user = data.user;
  req.token = token;

  next();
}

// A protected route for testing authentication.
app.get("/profile", verifyToken, (req, res) => {
  res.json({
    message: `Welcome to Joefriends, ${req.user.email}!`,
    userId: req.user.id,
  });
});

// Allow guests, but verify any token that is supplied.
function optionalAuth(req, res, next) {
  if (req.get("Authorization") !== undefined) {
    return verifyToken(req, res, next);
  }

  next();
}

// Create a post. Login is required.
app.post("/posts", verifyToken, async (req, res) => {
  const { title, content, visibility } = req.body || {};

  if (!isText(title) || !isText(content)) {
    return res.status(400).json({
      message: "Title and content are required.",
    });
  }

  if (title.trim().length > 200) {
    return res.status(400).json({
      message: "Title must not exceed 200 characters.",
    });
  }

  if (content.trim().length > 5000) {
    return res.status(400).json({
      message: "Content must not exceed 5000 characters.",
    });
  }

  if (visibility !== "public" && visibility !== "friends") {
    return res.status(400).json({
      message: "Visibility must be public or friends.",
    });
  }

  const supabase = createSupabaseClient(req.token);

  const { data, error } = await supabase
    .from("posts")
    .insert({
      user_id: req.user.id,
      title: title.trim(),
      content: content.trim(),
      visibility,
    })
    .select()
    .single();

  if (error) {
    throw error;
  }

  return res.status(201).json(data);
});

// Read posts. Supabase policies filter the results.
app.get("/posts", optionalAuth, async (req, res) => {
  const supabase = createSupabaseClient(req.token);

  const { data, error } = await supabase
    .from("posts")
    .select(`
      id,
      user_id,
      title,
      content,
      visibility,
      created_at,
      users(username)
    `)
    .order("created_at", { ascending: false });

  if (error) {
    throw error;
  }

  const posts = data.map((post) => ({
    id: post.id,
    user_id: post.user_id,
    title: post.title,
    content: post.content,
    visibility: post.visibility,
    created_at: post.created_at,
    author: post.users?.username || "Unknown",
  }));

  return res.json(posts);
});

// Check the format of a Supabase user ID.
function isUuid(value) {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
  );
}

// List other users.
app.get("/users", verifyToken, async (req, res) => {
  const supabase = createSupabaseClient(req.token);

  const { data, error } = await supabase
    .from("users")
    .select("id, username")
    .neq("id", req.user.id)
    .order("username");

  if (error) throw error;

  res.json(data);
});

// Send a friend request.
app.post("/friends", verifyToken, async (req, res) => {
  const { friend_id } = req.body || {};

  if (!isUuid(friend_id)) {
    return res.status(400).json({
      message: "A valid friend_id is required.",
    });
  }

  if (friend_id.toLowerCase() === req.user.id.toLowerCase()) {
    return res.status(400).json({
      message: "You cannot add yourself.",
    });
  }

  const supabase = createSupabaseClient(req.token);

  const { data: friend, error: userError } = await supabase
    .from("users")
    .select("id")
    .eq("id", friend_id)
    .maybeSingle();

  if (userError) throw userError;

  if (!friend) {
    return res.status(404).json({
      message: "User not found.",
    });
  }

  const { data, error } = await supabase
    .from("friendships")
    .insert({
      user_id: req.user.id,
      friend_id: friend.id,
      status: "pending",
    })
    .select()
    .single();

  if (error?.code === "23505") {
    return res.status(409).json({
      message: "A friend request or friendship already exists.",
    });
  }

  if (error) throw error;

  res.status(201).json({
    message: "Friend request sent.",
    friendship: data,
  });
});

// List incoming requests, outgoing requests, and accepted friends.
app.get("/friends", verifyToken, async (req, res) => {
  const supabase = createSupabaseClient(req.token);

  const { data, error } = await supabase
    .from("friendships")
    .select("id, user_id, friend_id, status, created_at")
    .or(`user_id.eq.${req.user.id},friend_id.eq.${req.user.id}`)
    .order("created_at", { ascending: false });

  if (error) throw error;

  res.json(data);
});

// Accept a request addressed to the logged-in user.
app.patch("/friends/:id/accept", verifyToken, async (req, res) => {
  const requestId = req.params.id;

  if (!/^[1-9]\d*$/.test(requestId) || requestId.length > 18) {
    return res.status(400).json({
      message: "Invalid friend request ID.",
    });
  }

  const supabase = createSupabaseClient(req.token);

  const { data, error } = await supabase
    .from("friendships")
    .update({ status: "accepted" })
    .eq("id", requestId)
    .eq("friend_id", req.user.id)
    .eq("status", "pending")
    .select()
    .maybeSingle();

  if (error) throw error;

  if (!data) {
    return res.status(404).json({
      message: "No pending request addressed to you was found.",
    });
  }

  res.json({
    message: "Friend request accepted.",
    friendship: data,
  });
});

// Keep this after all routes.
app.use((req, res) => {
  res.status(404).json({
    message: "Route not found.",
  });
});

// Handle unexpected errors.
app.use((error, req, res, next) => {
  if (error.type === "entity.parse.failed") {
    return res.status(400).json({
      message: "Request body must contain valid JSON.",
    });
  }

  if (error.type === "entity.too.large") {
    return res.status(413).json({
      message: "Request body is too large.",
    });
  }

  console.error(error.message);

  res.status(500).json({
    message: "An unexpected server error occurred.",
  });
});

app.listen(PORT, () => {
  console.log(`Joefriends API is running on port ${PORT}`);
});

