package com.acme.core;

public record Point(int x, int y) {

	public Point withX(int x) {
		return new Point(x, this.y);
	}

	public Point withY(int y) {
		return new Point(this.x, y);
	}
}
