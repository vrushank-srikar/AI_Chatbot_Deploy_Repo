import React, { useState } from "react";
import axios from "axios";
import { Link } from "react-router-dom";
import { jwtDecode } from "jwt-decode"; // ✅ Corrected import
import "../styles/form.css";

export default function Login() {
  const [form, setForm] = useState({ email: "", password: "" });

  const handleSubmit = async (e) => {
    e.preventDefault();

    if (!form.email || !form.password) {
      alert("Please fill all fields");
      return;
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(form.email)) {
      alert("Invalid email format");
      return;
    }

    try {
      const res = await axios.post("http://localhost:5000/api/login", form);

      const token = res.data.token;
      localStorage.setItem("token", token);

      // Decode JWT to get MongoDB user _id
      const decoded = jwtDecode(token); // ✅ Updated to jwtDecode
      const userId = decoded.id;

      // Redirect based on role
      if (res.data.role === "admin") {
        window.location.href = `/admin/${userId}`;
      } else {
        window.location.href = `/user/${userId}`;
      }
    } catch (err) {
      console.error(err);
      alert(err.response?.data?.error || "Login failed");
    }
  };

  return (
    <div className="form-container">
      <h2>Login</h2>
      <form onSubmit={handleSubmit} className="form-box">
        <input
          type="email"
          placeholder="Email"
          value={form.email}
          onChange={(e) => setForm({ ...form, email: e.target.value })}
          required
        />
        <input
          type="password"
          placeholder="Password"
          value={form.password}
          onChange={(e) => setForm({ ...form, password: e.target.value })}
          required
        />
        <button type="submit">Login</button>
      </form>
      <p style={{ marginTop: "15px" }}>
        Don't have an account?{" "}
        <Link to="/signup" className="signup-link">
          Signup
        </Link>
      </p>
    </div>
  );
}