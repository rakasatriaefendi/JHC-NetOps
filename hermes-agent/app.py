"""WSGI entry point for the Hermes Flask scaffold."""

from hermes_agent.app import app


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=7860)

